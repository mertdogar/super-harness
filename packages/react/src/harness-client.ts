// Framework-free wire layer: ONE super-line client driving one active thread.
// Modeled on packages/tui/src/session.ts — join first, then subscribeTree; the
// durable Store rebuilds the whole transcript on refresh/late-join. React
// binds via useSyncExternalStore in react.ts; non-React consumers can use this
// class directly (subpath export `@super-harness/react/client`).
import { createSuperLineClient, type SuperLineClient, type SuperLineClientOptions } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { memoryStoreClient } from "@super-line/store-memory"
import {
  contract,
  emptyTree,
  subscribeTree,
  type ApprovalDecision,
  type ClientTree,
  type Contract,
  type ModeInfo,
  type NodeState,
  type ThreadInfo,
} from "@super-harness/shared"

type Client = SuperLineClient<Contract, "user">
// ClientStore lives in @super-line/core; derive the map type instead of adding a dep.
type StoreClients = NonNullable<SuperLineClientOptions<Contract, "user">["stores"]>

export interface PendingAsk {
  toolCallId: string
  toolName: string
  request: unknown
  resumeSchema?: string
}

export interface PendingApproval {
  toolCallId: string
  toolName: string
  args: unknown
}

export interface HarnessState {
  connected: boolean
  threadId: string
  tree: ClientTree
  busy: boolean
  pendingAsk: PendingAsk | null
  pendingApproval: PendingApproval | null
  modes: ModeInfo[]
  defaultModeId?: string
  modeId: string | null
  threads: ThreadInfo[]
  queued: number
  notice: string | null
}

export interface HarnessClientConfig {
  /** WebSocket URL of the harness server, e.g. ws://localhost:4111/super-line */
  url: string
  /** Thread to join on connect. Full 21-char nanoid — never truncate. */
  threadId: string
  /** Handshake params (the default server authenticate reads `userId`). */
  params?: Record<string, string>
  /** Store clients for the `node`/`thread` namespaces (default: in-memory). */
  stores?: StoreClients
  /**
   * Test seam: a pre-built wire client (or factory — called once per
   * connect(), so a StrictMode-style close→connect cycle gets a fresh
   * instance like production does). Production callers never set this.
   */
  wire?: Client | (() => Client)
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A suspend payload may carry a JSON-schema string for its resumeData. A
// top-level string/array schema wants the raw answer, not { answer }.
function wantsBareAnswer(resumeSchema: string | undefined): boolean {
  if (!resumeSchema) return false
  try {
    return schemaIsStringOrArray(JSON.parse(resumeSchema))
  } catch {
    return false
  }
}

function schemaIsStringOrArray(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false
  const node = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown }
  if (node.type === "string" || node.type === "array") return true
  const branches = [node.anyOf, node.oneOf].find(Array.isArray)
  return Array.isArray(branches) && branches.some(schemaIsStringOrArray)
}

function findTool(tree: ClientTree, toolCallId: string) {
  for (const node of Object.values(tree.nodes)) {
    const t = node.tools[toolCallId]
    if (t) return t
  }
  return undefined
}

// Refresh mid-suspension: the `suspended` room event is ephemeral, but the
// parked ask_user call is visible in the tree — root-only, input-available,
// no result yet. Only the LAST turn root counts: turns are serialized, so an
// earlier still-"running" root is stale data, not a live question. (Approval
// suspensions can't be told apart from a tool that is merely executing, so
// those stay live-event-only.)
function inferAsk(root: NodeState | undefined): PendingAsk | null {
  if (root?.status !== "running") return null
  for (const tid of root.toolOrder) {
    const t = root.tools[tid]
    if (t.toolName === "ask_user" && t.status === "input-available") {
      return { toolCallId: tid, toolName: t.toolName, request: t.args }
    }
  }
  return null
}

export function createHarnessClient(config: HarnessClientConfig): HarnessClient {
  return new HarnessClient(config)
}

export class HarnessClient {
  #config: HarnessClientConfig
  #client: Client | null = null
  #listeners = new Set<() => void>()
  #unsubTree: (() => void) | null = null
  #poll: ReturnType<typeof setInterval> | null = null
  #state: HarnessState

  constructor(config: HarnessClientConfig) {
    this.#config = config
    this.#state = {
      connected: false,
      threadId: config.threadId,
      tree: emptyTree(),
      busy: false,
      pendingAsk: null,
      pendingApproval: null,
      modes: [],
      modeId: null,
      threads: [],
      queued: 0,
      notice: null,
    }
  }

  getSnapshot = (): HarnessState => this.#state

  subscribe = (cb: () => void): (() => void) => {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  #set(patch: Partial<HarnessState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const cb of this.#listeners) cb()
  }

  async connect(): Promise<void> {
    // #client is assigned synchronously below, so this single guard makes
    // connect() idempotent — and a close() between StrictMode mounts nulls it,
    // letting the remount start a FRESH session while the first attempt's
    // awaits abandon themselves via the `#client !== client` checks.
    if (this.#client) return
    const wire = this.#config.wire
    const client: Client = (typeof wire === "function" ? wire() : wire) ??
      createSuperLineClient(contract, {
        transport: webSocketClientTransport({ url: this.#config.url }),
        role: "user",
        params: this.#config.params,
        stores: this.#config.stores ?? { node: memoryStoreClient(), thread: memoryStoreClient() },
      })
    this.#client = client

    client.on("suspended", (p) => {
      if (p.threadId !== this.#state.threadId) return
      this.#set({
        busy: false, // parked server-side until reply
        pendingAsk: { toolCallId: p.toolCallId, toolName: p.toolName, request: p.request, resumeSchema: p.resumeSchema },
      })
    })
    client.on("approvalRequired", (p) => {
      if (p.threadId !== this.#state.threadId) return
      this.#set({ pendingApproval: { toolCallId: p.toolCallId, toolName: p.toolName, args: p.args } })
    })
    client.on("modeChanged", (p) => {
      if (p.threadId !== this.#state.threadId) return
      this.#set({ modeId: p.modeId })
    })
    client.on("followUpQueued", (p) => {
      if (p.threadId !== this.#state.threadId) return
      this.#set({ queued: p.count })
    })
    // No active-thread guard: a background thread's title can change (e.g.
    // auto-title after its first turn) while a different thread is open —
    // the sidebar must still update.
    client.on("threadRenamed", (p) => {
      const known = this.#state.threads.some((t) => t.id === p.threadId)
      if (!known) return void this.refreshThreads()
      this.#set({ threads: this.#state.threads.map((t) => (t.id === p.threadId ? { ...t, title: p.title } : t)) })
    })

    try {
      await client.join({ threadId: this.#state.threadId })
      if (this.#client !== client) return // closed mid-connect (StrictMode unmount)
      this.#subscribeTree()
      this.#set({ connected: client.connected })
      void this.refreshModes()
      void this.refreshThreads()
    } catch (error) {
      // Leave connected=false — the poll below sees the transition once the
      // socket is up and retries the whole join+subscribe path.
      if (this.#client === client) this.#set({ notice: errMessage(error) })
    } finally {
      if (this.#client === client) this.#startPoll()
    }
  }

  #subscribeTree(): void {
    this.#unsubTree?.()
    if (!this.#client) return
    this.#unsubTree = subscribeTree(this.#client, this.#state.threadId, (tree) => this.#onTree(tree))
  }

  #onTree(tree: ClientTree): void {
    const lastRoot: NodeState | undefined = tree.nodes[tree.turns[tree.turns.length - 1] ?? ""]
    const rootRunning = lastRoot?.status === "running"
    let { pendingAsk, pendingApproval } = this.#state
    // The tree is the truth: a pending prompt is over once its tool settles or
    // the turn stops running (abort/error). Live events only ever ADD pendings.
    const settled = (id: string) => {
      const t = findTool(tree, id)
      return t !== undefined && (t.status === "output-available" || t.status === "error")
    }
    if (pendingAsk && (settled(pendingAsk.toolCallId) || !rootRunning)) pendingAsk = null
    if (pendingApproval && (settled(pendingApproval.toolCallId) || !rootRunning)) pendingApproval = null
    if (!pendingAsk && rootRunning) pendingAsk = inferAsk(lastRoot)
    // A parked ask_user keeps the root 'running' in the tree, but the server is
    // idle waiting on the user — that's not busy.
    const busy = rootRunning && !pendingAsk
    const wasBusy = this.#state.busy
    this.#set({ tree, busy, pendingAsk, pendingApproval, queued: busy ? this.#state.queued : 0 })
    // A settled turn may have created/renamed the Mastra thread — refresh the list.
    if (wasBusy && !busy) void this.refreshThreads()
  }

  #startPoll(): void {
    // ponytail: 1s poll — super-line exposes `connected` but no connect/
    // disconnect event. On recovery re-join (server drops session + room).
    this.#poll = setInterval(() => {
      const now = this.#client?.connected ?? false
      if (now === this.#state.connected) return
      if (now) {
        void this.#client
          ?.join({ threadId: this.#state.threadId })
          .then(() => this.#subscribeTree())
          .catch((error) => this.#set({ notice: errMessage(error) }))
      }
      this.#set({ connected: now, busy: false, pendingAsk: null, pendingApproval: null })
    }, 1000)
  }

  async send(text: string): Promise<void> {
    const message = text.trim()
    if (!message || !this.#client) return
    try {
      // Busy thread? The server queues it and broadcasts followUpQueued.
      await this.#client.sendMessage({ threadId: this.#state.threadId, message })
      this.#set({ notice: null })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async reply(text: string): Promise<void> {
    const pending = this.#state.pendingAsk
    if (!pending || !this.#client) return
    const answer = text.trim()
    const resumeData = pending.request === undefined
      ? { approved: answer.toLowerCase() === "yes" || answer.toLowerCase() === "y" }
      : wantsBareAnswer(pending.resumeSchema)
        ? answer
        : { answer }
    try {
      const res = await this.#client.resumeMessage({
        threadId: this.#state.threadId,
        toolCallId: pending.toolCallId,
        resumeData,
      })
      // ok:false = the harness rejected the resume (e.g. a queued follow-up is
      // mid-turn) — keep the prompt so the answer isn't silently lost.
      if (res.ok) this.#set({ pendingAsk: null, notice: null })
      else this.#set({ notice: "reply was rejected by the server — dismiss the prompt or retry once the thread settles" })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async respond(decision: ApprovalDecision, message?: string): Promise<void> {
    const pending = this.#state.pendingApproval
    if (!pending || !this.#client) return
    try {
      const res = await this.#client.respondToApproval({
        threadId: this.#state.threadId,
        toolCallId: pending.toolCallId,
        decision,
        message,
      })
      if (res.ok) this.#set({ pendingApproval: null })
      else this.#set({ notice: "approval was rejected by the server" })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  // Local-only escape hatch: drop a pending ask the server no longer knows
  // about (e.g. it restarted while the suspension was parked).
  dismissAsk(): void {
    this.#set({ pendingAsk: null, notice: null })
  }

  async abort(): Promise<void> {
    if (!this.#client) return
    try {
      await this.#client.abort({ threadId: this.#state.threadId })
      // The server cleared suspensions and declined gates — mirror it locally
      // (tui parity); the tree write for a parked node may lag or not come.
      this.#set({ busy: false, pendingAsk: null, pendingApproval: null, queued: 0 })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.#client) return
    try {
      const res = await this.#client.switchMode({ threadId: this.#state.threadId, modeId })
      if (res.ok) this.#set({ modeId })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  // Both refreshers are invoked fire-and-forget (`void this.refresh…`) — they
  // must never reject, or a dropped socket at refresh time becomes an
  // unhandled rejection.
  async refreshModes(): Promise<void> {
    if (!this.#client) return
    try {
      const { modes, defaultModeId } = await this.#client.listModes({})
      this.#set({ modes, defaultModeId })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async refreshThreads(): Promise<void> {
    if (!this.#client) return
    try {
      const { threads } = await this.#client.listThreads({})
      this.#set({ threads })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async switchThread(threadId: string): Promise<void> {
    if (!this.#client || threadId === this.#state.threadId) return
    // Detach the OLD thread's subscription before touching state — its
    // callbacks must not repopulate tree/pendings under the new threadId.
    this.#unsubTree?.()
    this.#unsubTree = null
    this.#set({
      threadId,
      tree: emptyTree(),
      busy: false,
      pendingAsk: null,
      pendingApproval: null,
      queued: 0,
      // The contract has no "get thread mode" read; show the default until a
      // live modeChanged corrects it.
      modeId: null,
    })
    try {
      await this.#client.join({ threadId })
      this.#subscribeTree()
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async newThread(): Promise<string | null> {
    if (!this.#client) return null
    try {
      const { threadId } = await this.#client.createThread({})
      await this.switchThread(threadId)
      void this.refreshThreads()
      return threadId
    } catch (error) {
      this.#set({ notice: errMessage(error) })
      return null
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!this.#client) return
    try {
      await this.#client.deleteThread({ threadId })
      if (threadId === this.#state.threadId) await this.newThread()
      else void this.refreshThreads()
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  close(): void {
    if (this.#poll) clearInterval(this.#poll)
    this.#poll = null
    this.#unsubTree?.()
    this.#unsubTree = null
    this.#client?.close()
    this.#client = null
  }
}
