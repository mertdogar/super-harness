// Framework-free wire layer: ONE super-line client driving one active thread.
// Modeled on packages/tui/src/session.ts — join first, then subscribeTree; the
// durable Store rebuilds the whole transcript on refresh/late-join. React
// binds via useSyncExternalStore in react.ts; non-React consumers can use this
// class directly (subpath export `@super-harness/react/client`).
//
// Two ways in: give a `url` and this layer owns its own socket (standalone
// serve()), or give the host app's existing `client` (composition — a host
// contract that merges harnessSurface) and this layer borrows it: listeners
// are attached on connect() and detached on close(), the socket is never
// closed here.
import { createSuperLineClient, type SuperLineClientOptions } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { memoryStoreClient } from "@super-line/store-memory"
import {
  contract,
  emptyTree,
  HARNESS_NODE_STORE,
  HARNESS_THREAD_STORE,
  subscribeTree,
  type ApprovalDecision,
  type ApprovalRequired,
  type ClientTree,
  type Contract,
  type ModeInfo,
  type NodeState,
  type Suspended,
  type ThreadInfo,
} from "@super-harness/shared"

// ClientStore lives in @super-line/core; derive the map type instead of adding a dep.
type StoreClients = NonNullable<SuperLineClientOptions<Contract, "user">["stores"]>

// The server-pushed events the harness layer listens for, by payload.
export interface HarnessWireEvents {
  "harness.suspended": Suspended
  "harness.approvalRequired": ApprovalRequired
  "harness.modeChanged": { threadId: string; modeId: string; previousModeId: string }
  "harness.followUpQueued": { threadId: string; count: number }
  "harness.threadCreated": ThreadInfo
  "harness.threadRenamed": { threadId: string; title: string }
  "harness.threadDeleted": { threadId: string }
}

// Structural view of the super-line client surface this layer drives — a
// client built against ANY host contract that merges harnessSurface fits,
// without importing that contract here.
export interface HarnessWire {
  "harness.join"(input: { threadId: string }): Promise<{ ok: boolean }>
  "harness.sendMessage"(input: { threadId: string; message: string }): Promise<{ ok: boolean }>
  "harness.resumeMessage"(input: { threadId: string; toolCallId?: string; resumeData?: unknown }): Promise<{ ok: boolean }>
  "harness.abort"(input: { threadId: string }): Promise<{ ok: boolean }>
  "harness.respondToApproval"(input: {
    threadId: string
    toolCallId?: string
    decision: ApprovalDecision
    message?: string
  }): Promise<{ ok: boolean }>
  "harness.switchMode"(input: { threadId: string; modeId: string }): Promise<{ ok: boolean }>
  "harness.listModes"(input: Record<string, never>): Promise<{ modes: ModeInfo[]; defaultModeId?: string }>
  "harness.listThreads"(input: { resourceId?: string }): Promise<{ threads: ThreadInfo[] }>
  "harness.createThread"(input: { threadId?: string; resourceId?: string; title?: string }): Promise<{ threadId: string }>
  "harness.deleteThread"(input: { threadId: string }): Promise<{ ok: boolean }>
  // Concrete overloads (not a generic) — a generic-to-generic comparison with
  // the real client's `on` fails higher-order inference; per-overload
  // instantiation matches cleanly.
  on(event: "harness.suspended", handler: (data: HarnessWireEvents["harness.suspended"]) => void): () => void
  on(event: "harness.approvalRequired", handler: (data: HarnessWireEvents["harness.approvalRequired"]) => void): () => void
  on(event: "harness.modeChanged", handler: (data: HarnessWireEvents["harness.modeChanged"]) => void): () => void
  on(event: "harness.followUpQueued", handler: (data: HarnessWireEvents["harness.followUpQueued"]) => void): () => void
  on(event: "harness.threadCreated", handler: (data: HarnessWireEvents["harness.threadCreated"]) => void): () => void
  on(event: "harness.threadRenamed", handler: (data: HarnessWireEvents["harness.threadRenamed"]) => void): () => void
  on(event: "harness.threadDeleted", handler: (data: HarnessWireEvents["harness.threadDeleted"]) => void): () => void
  store(name: string): { open(id: string): { getSnapshot(): unknown; subscribe(cb: () => void): () => void; close(): void } }
  close(): void
  readonly connected: boolean
}

// The harness Store namespaces as client replicas — spread into a host
// client's `stores` config next to its own:
//   createSuperLineClient(hostContract, { stores: { ...harnessClientStores(), ...own } })
export function harnessClientStores(): StoreClients {
  return { [HARNESS_NODE_STORE]: memoryStoreClient(), [HARNESS_THREAD_STORE]: memoryStoreClient() } as StoreClients
}

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
  // The active thread was deleted elsewhere (another tab / resource peer). The
  // tab is in limbo until the user picks or creates a thread.
  activeThreadDeleted: boolean
}

export interface HarnessClientConfig {
  /** Thread to join on connect. Full 21-char nanoid — never truncate. */
  threadId: string
  /** WebSocket URL of a standalone harness server (owned mode: connect() builds a fresh client, close() closes it). */
  url?: string
  /** Handshake params (the default server authenticate reads `userId`). Owned mode only. */
  params?: Record<string, string>
  /** Store clients for the `harness.node`/`harness.thread` namespaces (default: in-memory). Owned mode only. */
  stores?: StoreClients
  /**
   * Composition: the host app's existing super-line client, built against a
   * contract that merges harnessSurface. A live INSTANCE is borrowed — close()
   * detaches the harness listeners but never closes the host's socket. A
   * FACTORY is owned like the url path (called once per connect(), closed on
   * close()) — the seam tests use to construct a fresh fake per connect.
   */
  client?: HarnessWire | (() => HarnessWire)
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
  #client: HarnessWire | null = null
  #owned = false
  // Session epoch: bumped by every close(). Abandon guards compare epochs, not
  // client identity — a borrowed instance is the SAME object across a
  // StrictMode close()→connect() remount, so identity can't tell sessions
  // apart (the first session's finally would start a second, leaked poll).
  #epoch = 0
  #unsubs: Array<() => void> = []
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
      activeThreadDeleted: false,
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

  #build(): HarnessWire {
    const source = this.#config.client
    if (typeof source === "function") return source()
    if (source) return source
    if (!this.#config.url) throw new Error("HarnessClientConfig needs a url or a client")
    return createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url: this.#config.url }),
      role: "user",
      params: this.#config.params,
      stores: this.#config.stores ?? harnessClientStores(),
    }) as unknown as HarnessWire
  }

  async connect(): Promise<void> {
    // #client is assigned synchronously below, so this single guard makes
    // connect() idempotent — and a close() between StrictMode mounts nulls it,
    // letting the remount start a FRESH session while the first attempt's
    // awaits abandon themselves via the epoch checks.
    if (this.#client) return
    const epoch = this.#epoch
    const client = this.#build()
    // A live instance is the host's (borrowed); anything constructed here —
    // via url or the factory seam — is this layer's to close.
    this.#owned = typeof this.#config.client !== "object"
    this.#client = client

    this.#unsubs = [
      client.on("harness.suspended", (p) => {
        if (p.threadId !== this.#state.threadId) return
        this.#set({
          busy: false, // parked server-side until reply
          pendingAsk: { toolCallId: p.toolCallId, toolName: p.toolName, request: p.request, resumeSchema: p.resumeSchema },
        })
      }),
      client.on("harness.approvalRequired", (p) => {
        if (p.threadId !== this.#state.threadId) return
        this.#set({ pendingApproval: { toolCallId: p.toolCallId, toolName: p.toolName, args: p.args } })
      }),
      client.on("harness.modeChanged", (p) => {
        if (p.threadId !== this.#state.threadId) return
        this.#set({ modeId: p.modeId })
      }),
      client.on("harness.followUpQueued", (p) => {
        if (p.threadId !== this.#state.threadId) return
        this.#set({ queued: p.count })
      }),
      // Thread-list events carry NO active-thread guard: they broadcast to the
      // resource room, so they concern the sidebar regardless of which thread
      // this tab is viewing.
      client.on("harness.threadCreated", (t) => {
        if (this.#state.threads.some((x) => x.id === t.id)) return // our own create echoes back
        this.#set({ threads: [t, ...this.#state.threads] })
      }),
      client.on("harness.threadRenamed", (p) => {
        const known = this.#state.threads.some((t) => t.id === p.threadId)
        if (!known) return void this.refreshThreads()
        this.#set({ threads: this.#state.threads.map((t) => (t.id === p.threadId ? { ...t, title: p.title } : t)) })
      }),
      client.on("harness.threadDeleted", (p) => {
        const threads = this.#state.threads.filter((t) => t.id !== p.threadId)
        if (p.threadId !== this.#state.threadId) return this.#set({ threads })
        // Our OWN active thread was deleted elsewhere — settle into the deleted
        // state (per grill decision (c)): drop the subscription, blank the tree,
        // let the user pick or create a thread.
        this.#unsubTree?.()
        this.#unsubTree = null
        this.#set({
          threads,
          tree: emptyTree(),
          busy: false,
          pendingAsk: null,
          pendingApproval: null,
          queued: 0,
          activeThreadDeleted: true,
        })
      }),
    ]

    try {
      await client["harness.join"]({ threadId: this.#state.threadId })
      if (this.#epoch !== epoch) return // closed mid-connect (StrictMode unmount)
      this.#subscribeTree()
      this.#set({ connected: client.connected })
      void this.refreshModes()
      void this.refreshThreads()
    } catch (error) {
      // Leave connected=false — the poll below sees the transition once the
      // socket is up and retries the whole join+subscribe path.
      if (this.#epoch === epoch) this.#set({ notice: errMessage(error) })
    } finally {
      if (this.#epoch === epoch) this.#startPoll()
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
    // Borrowed mode keeps the poll: rooms are per-connection, so after the
    // HOST's transport reconnects someone must re-join + re-subscribe, and
    // only this layer knows its rooms. The poll never touches the socket.
    if (this.#poll) clearInterval(this.#poll)
    const epoch = this.#epoch
    this.#poll = setInterval(() => {
      const now = this.#client?.connected ?? false
      if (now === this.#state.connected) return
      // Don't re-join in the activeThreadDeleted limbo — the server's join
      // pre-create would resurrect an empty doc for the purged thread.
      if (now && !this.#state.activeThreadDeleted) {
        void this.#client
          ?.["harness.join"]({ threadId: this.#state.threadId })
          .then(() => {
            if (this.#epoch === epoch) this.#subscribeTree()
          })
          .catch((error) => {
            if (this.#epoch === epoch) this.#set({ notice: errMessage(error) })
          })
      }
      this.#set({ connected: now, busy: false, pendingAsk: null, pendingApproval: null })
    }, 1000)
  }

  async send(text: string): Promise<void> {
    const message = text.trim()
    if (!message || !this.#client) return
    try {
      // Busy thread? The server queues it and broadcasts followUpQueued.
      await this.#client["harness.sendMessage"]({ threadId: this.#state.threadId, message })
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
      const res = await this.#client["harness.resumeMessage"]({
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
      const res = await this.#client["harness.respondToApproval"]({
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
      await this.#client["harness.abort"]({ threadId: this.#state.threadId })
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
      const res = await this.#client["harness.switchMode"]({ threadId: this.#state.threadId, modeId })
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
      const { modes, defaultModeId } = await this.#client["harness.listModes"]({})
      this.#set({ modes, defaultModeId })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async refreshThreads(): Promise<void> {
    if (!this.#client) return
    try {
      const { threads } = await this.#client["harness.listThreads"]({})
      this.#set({ threads })
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  async switchThread(threadId: string): Promise<void> {
    if (!this.#client || threadId === this.#state.threadId) return
    const epoch = this.#epoch
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
      activeThreadDeleted: false, // leaving limbo for a live thread
      // The contract has no "get thread mode" read; show the default until a
      // live modeChanged corrects it.
      modeId: null,
    })
    try {
      await this.#client["harness.join"]({ threadId })
      if (this.#epoch === epoch) this.#subscribeTree()
    } catch (error) {
      if (this.#epoch === epoch) this.#set({ notice: errMessage(error) })
    }
  }

  async newThread(): Promise<string | null> {
    if (!this.#client) return null
    try {
      const { threadId } = await this.#client["harness.createThread"]({})
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
      await this.#client["harness.deleteThread"]({ threadId })
      if (threadId === this.#state.threadId) await this.newThread()
      else void this.refreshThreads()
    } catch (error) {
      this.#set({ notice: errMessage(error) })
    }
  }

  close(): void {
    this.#epoch++ // abandon any in-flight connect/poll callbacks
    if (this.#poll) clearInterval(this.#poll)
    this.#poll = null
    this.#unsubTree?.()
    this.#unsubTree = null
    for (const off of this.#unsubs.splice(0)) off()
    // Borrowed clients belong to the host — only close what this layer built.
    if (this.#owned) this.#client?.close()
    this.#client = null
  }
}
