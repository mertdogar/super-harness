// The harness core: one super-line client driving one thread against a
// super-harness server, shared by both shells (TUI + headless). It reads the tree
// from the durable Store (subscribeTree), turns snapshot changes into the
// HarnessEvent stream both shells consume (diffTree), and owns wire state
// (busy / pending suspension). No rendering, no stdin here.

import { createSuperLineClient, type SuperLineClient } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { memoryStoreClient } from "@super-line/store-memory"
import { nanoid } from "nanoid"
import {
  contract,
  diffTree,
  emptyTree,
  subscribeTree,
  type ClientTree,
  type Contract,
  type HarnessEvent,
} from "@super-harness/shared"
import type { HarnessConfig } from "./config"

type Client = SuperLineClient<Contract, "user">

export interface Pending {
  nodeId: string
  toolCallId: string
  toolName: string
  request: unknown
  resumeSchema?: string
}

export type Status =
  | { kind: "ready" }
  | { kind: "turn_start"; runId: string }
  | { kind: "turn_done"; tools: number; errors: number; tokens: number }
  | { kind: "suspended"; toolName: string; request: unknown; resumeSchema?: string }
  | { kind: "approval_required"; toolName: string; args: unknown }
  | { kind: "error"; message: string }
  | { kind: "disconnected" }
  | { kind: "reconnected" }
  | { kind: "info"; message: string }

export interface PendingApproval {
  toolCallId: string
  toolName: string
  args: unknown
}

export interface Handlers {
  onEvent: (event: HarnessEvent) => void
  onTree: (tree: ClientTree) => void
  onLine: (line: string) => void
  onStatus: (status: Status) => void
}

const NOOP: Handlers = { onEvent: () => {}, onTree: () => {}, onLine: () => {}, onStatus: () => {} }

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A suspend payload may carry a JSON-schema string for its resumeData. A top-level
// string/array schema wants the raw answer, not { answer }.
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

export class HarnessSession {
  readonly config: HarnessConfig
  busy = false
  pending: Pending | null = null
  pendingApproval: PendingApproval | null = null
  threadId: string

  private client: Client | null = null
  private handlers: Handlers = NOOP
  private counts = { tools: 0, errors: 0, tokens: 0 }
  private connected = false
  private poll: ReturnType<typeof setInterval> | null = null
  private unsubTree: (() => void) | null = null
  private prevTree: ClientTree = emptyTree()
  private currentRoot: string | null = null

  constructor(config: HarnessConfig) {
    this.config = config
    this.threadId = config.threadId
  }

  setHandlers(handlers: Handlers): void {
    this.handlers = handlers
  }

  get isConnected(): boolean {
    return this.client?.connected ?? false
  }

  async connect(): Promise<void> {
    const client: Client = createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url: this.config.url }),
      role: "user",
      params: this.config.params,
      stores: { node: memoryStoreClient(), thread: memoryStoreClient() },
    })
    this.client = client

    client.on("suspended", (payload) => {
      if (payload.threadId !== this.threadId) return
      this.busy = false // the turn is parked server-side until /reply
      this.pending = {
        nodeId: payload.nodeId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        request: payload.request,
        resumeSchema: payload.resumeSchema,
      }
      this.handlers.onStatus({
        kind: "suspended",
        toolName: payload.toolName,
        request: payload.request,
        resumeSchema: payload.resumeSchema,
      })
    })

    client.on("approvalRequired", (payload) => {
      if (payload.threadId !== this.threadId) return
      this.pendingApproval = { toolCallId: payload.toolCallId, toolName: payload.toolName, args: payload.args }
      this.handlers.onStatus({ kind: "approval_required", toolName: payload.toolName, args: payload.args })
    })

    client.on("modeChanged", (payload) => {
      if (payload.threadId !== this.threadId) return
      this.handlers.onStatus({ kind: "info", message: `mode: ${payload.previousModeId} → ${payload.modeId}` })
    })

    client.on("followUpQueued", (payload) => {
      if (payload.threadId !== this.threadId) return
      this.handlers.onStatus({ kind: "info", message: `follow-ups queued: ${payload.count}` })
    })

    // Join first (the server pre-creates the thread Store Resource granted to us),
    // THEN subscribe — opening a not-yet-existent Resource yields a dead handle.
    await this.joinCurrent()
    this.subscribe()
    this.connected = client.connected
    this.handlers.onStatus({ kind: "ready" })
    this.startPoll()
  }

  private subscribe(): void {
    this.unsubTree?.()
    this.prevTree = emptyTree()
    if (!this.client) return
    this.unsubTree = subscribeTree(this.client, this.threadId, (tree) => this.onTree(tree))
  }

  private onTree(tree: ClientTree): void {
    const events = diffTree(this.prevTree, tree)
    this.prevTree = tree
    this.handlers.onTree(tree)
    for (const event of events) this.onHarnessEvent(event)
  }

  private onHarnessEvent(event: HarnessEvent): void {
    this.handlers.onEvent(event)
    if (event.type === "tool_start") this.counts.tools++
    if (event.type === "error") this.counts.errors++
    // Track EVERY root node, not just ones this client initiated — server-drained
    // follow-up turns must emit turn_start/turn_done too.
    if (event.type === "node_start" && event.parentNodeId === null && !this.currentRoot) {
      this.currentRoot = event.nodeId
      this.busy = true
      this.counts = { tools: 0, errors: 0, tokens: 0 }
      this.handlers.onStatus({ kind: "turn_start", runId: event.nodeId })
    }
    if (event.type === "node_end") {
      if (event.reason === "error") this.counts.errors++
      if (event.usage?.totalTokens) this.counts.tokens += event.usage.totalTokens
      if (event.parentNodeId === null && event.nodeId === this.currentRoot) {
        this.busy = false
        this.currentRoot = null
        this.handlers.onStatus({ kind: "turn_done", ...this.counts })
      }
    }
  }

  private startPoll(): void {
    // ponytail: 1s poll for connection transitions — super-line exposes `connected`
    // but no connect/disconnect event. On recovery re-join (server drops session +
    // room on disconnect) and reset the live turn.
    this.poll = setInterval(() => {
      const now = this.client?.connected ?? false
      if (now === this.connected) return
      this.connected = now
      this.busy = false
      this.pending = null
      this.pendingApproval = null
      if (now) {
        this.handlers.onStatus({ kind: "reconnected" })
        void this.joinCurrent().catch((error) => this.handlers.onStatus({ kind: "error", message: errMessage(error) }))
      } else {
        this.handlers.onStatus({ kind: "disconnected" })
      }
    }, 1000)
  }

  private async joinCurrent(): Promise<void> {
    if (!this.client) return
    await this.client.join({ threadId: this.threadId })
  }

  private emitLine(text: string): void {
    for (const line of text.split("\n")) this.handlers.onLine(line)
  }

  async send(text: string): Promise<void> {
    const message = text.trim()
    if (!message) return
    if (!this.client?.connected) {
      this.handlers.onStatus({ kind: "info", message: "not connected" })
      return
    }
    try {
      await this.joinCurrent()
      // Busy thread? The server queues it and broadcasts followUpQueued.
      await this.client.sendMessage({ threadId: this.threadId, message })
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  async approve(decision: "approve" | "decline" | "always_allow", message?: string): Promise<void> {
    if (!this.pendingApproval) {
      this.handlers.onStatus({ kind: "info", message: "no tool approval is pending" })
      return
    }
    if (!this.client) return
    const { toolCallId } = this.pendingApproval
    try {
      const res = await this.client.respondToApproval({ threadId: this.threadId, toolCallId, decision, message })
      if (res.ok) this.pendingApproval = null
      else this.handlers.onStatus({ kind: "error", message: "approval was rejected by the server" })
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  async switchMode(modeId: string): Promise<void> {
    if (!this.client) return
    try {
      const res = await this.client.switchMode({ threadId: this.threadId, modeId })
      if (!res.ok) this.handlers.onStatus({ kind: "info", message: `mode switch failed (unknown mode?)` })
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  async listModes(): Promise<void> {
    if (!this.client) return
    try {
      const { modes, defaultModeId } = await this.client.listModes({})
      if (modes.length === 0) return this.info("no modes configured")
      for (const m of modes) {
        this.emitLine(`${m.id === defaultModeId ? "*" : " "} ${m.id}${m.name ? `  (${m.name})` : ""}${m.description ? ` — ${m.description}` : ""}`)
      }
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  async listThreads(): Promise<void> {
    if (!this.client) return
    try {
      const { threads } = await this.client.listThreads({})
      if (threads.length === 0) return this.info("no threads (is a memory store configured on the harness?)")
      for (const t of threads) {
        const marker = t.id === this.threadId ? "*" : " "
        this.emitLine(`${marker} ${t.id}${t.title ? `  ${t.title}` : ""}${t.updatedAt ? `  (${t.updatedAt})` : ""}`)
      }
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  async reply(text: string): Promise<void> {
    if (!this.pending) {
      this.handlers.onStatus({ kind: "info", message: "nothing is waiting for a reply" })
      return
    }
    if (!this.client) return
    const { toolCallId, request, resumeSchema } = this.pending
    const answer = text.trim()
    const resumeData =
      request === undefined
        ? { approved: answer.toLowerCase() === "yes" || answer.toLowerCase() === "y" }
        : wantsBareAnswer(resumeSchema)
          ? answer
          : { answer }
    this.pending = null
    try {
      await this.client.resumeMessage({ threadId: this.threadId, toolCallId, resumeData })
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  async abort(): Promise<void> {
    if (!this.client) return
    try {
      await this.client.abort({ threadId: this.threadId })
      this.busy = false
      this.pending = null // the server cleared suspensions and declined approvals
      this.pendingApproval = null
      this.handlers.onStatus({ kind: "info", message: "turn aborted" })
    } catch (error) {
      this.handlers.onStatus({ kind: "error", message: errMessage(error) })
    }
  }

  printSession(): void {
    this.emitLine(
      JSON.stringify(
        {
          threadId: this.threadId,
          url: this.config.url,
          connected: this.client?.connected ?? false,
          busy: this.busy,
          pending: this.pending?.toolName ?? null,
        },
        null,
        2,
      ),
    )
  }

  newThread(id?: string): void {
    this.threadId = id ?? nanoid()
    this.busy = false
    this.pending = null
    this.pendingApproval = null
    this.counts = { tools: 0, errors: 0, tokens: 0 }
    this.handlers.onStatus({ kind: "info", message: `new thread ${this.threadId}` })
    // join (server pre-creates the thread Resource) then subscribe — see connect().
    void this.joinCurrent()
      .then(() => this.subscribe())
      .catch((error) => this.handlers.onStatus({ kind: "error", message: errMessage(error) }))
  }

  info(message: string): void {
    this.handlers.onStatus({ kind: "info", message })
  }

  line(text: string): void {
    this.emitLine(text)
  }

  close(): void {
    if (this.poll) clearInterval(this.poll)
    this.unsubTree?.()
    this.client?.close()
  }
}
