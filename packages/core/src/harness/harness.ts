// The AgentController-style host, transport-free. Mastra-first at the surface
// (createHarness takes Agent instances for the supervisor AND every subagent),
// framework-agnostic inside (the Harness drives nodes through RunnerFactories;
// the self-check passes fakes). It consolidates delegation (delegatesTo edges,
// depth-gated), event reduction (chunk-adapter → per-node HarnessEvents), and
// state consolidation (Projector → one live tree per thread), and hosts the
// session runtime: a typed event bus, a follow-up queue with steering, a
// suspension registry (parallel ask_user by toolCallId), tool-approval gating
// with permission rules, per-thread modes, and a thread facade over Mastra
// Memory. @super-harness/server binds all of it to super-line via serve().

import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import type { ToolsInput } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import { nanoid } from 'nanoid'
import type { FileAttachment, HarnessEvent, HarnessTree, TokenUsage } from '@super-harness/shared'
import type { Suspension } from './chunk-adapter'
import { Projector } from './projector'
import { runNode, type AgentRunner, type ApprovalRequest, type NodeEnvelope, type RunOptions, type StreamResult } from './run-node'
import { DELEGATE_TOOL, HARNESS_RUNTIME_KEY, type HarnessRuntime } from './runtime'
import { makeDelegateTool, askUserTool, todoTool } from './tools'

// ── permissions ──────────────────────────────────────────────────────────────

export type PermissionPolicy = 'allow' | 'ask' | 'deny'
export type ToolCategory = 'read' | 'edit' | 'execute' | 'mcp' | 'other'

export interface PermissionRules {
  categories?: Partial<Record<ToolCategory, PermissionPolicy>>
  tools?: Partial<Record<string, PermissionPolicy>>
}

export type ApprovalDecision = 'approve' | 'decline' | 'always_allow' | 'always_allow_category'

// Built-ins never gate — they are the harness's own machinery.
const BUILTIN_TOOLS = new Set(['todo', 'ask_user', DELEGATE_TOOL])

// ── modes ────────────────────────────────────────────────────────────────────

export interface HarnessMode {
  id: string
  name?: string
  description?: string
  // Layered onto the supervisor's own instructions for turns in this mode.
  instructions?: string
  // LLM-visible tool allowlist for supervisor turns in this mode (activeTools).
  availableTools?: string[]
  // metadata.default === true marks the default mode when defaultModeId is unset.
  metadata?: Record<string, unknown>
}

// ── threads ──────────────────────────────────────────────────────────────────

// Structural subset of MastraMemory — fakeable in tests, no hard Memory import.
export interface ThreadRecord {
  id: string
  resourceId: string
  title?: string
  metadata?: Record<string, unknown>
  createdAt?: Date | string
  updatedAt?: Date | string
}

export interface ThreadStore {
  createThread(args: { threadId?: string; resourceId: string; title?: string }): Promise<ThreadRecord>
  getThreadById(args: { threadId: string }): Promise<ThreadRecord | null>
  saveThread(args: { thread: ThreadRecord }): Promise<unknown>
  deleteThread(threadId: string): Promise<void>
  listThreads(args: { perPage?: number | false; filter?: { resourceId?: string } }): Promise<{ threads: ThreadRecord[] }>
}

export interface ThreadInfo {
  id: string
  resourceId: string
  title?: string
  createdAt?: string
  updatedAt?: string
}

// ── bus events ───────────────────────────────────────────────────────────────

export type HarnessSessionEvent =
  | { type: 'suspended'; nodeId: string; toolCallId: string; toolName: string; request?: unknown; resumeSchema?: string }
  | { type: 'approval_required'; nodeId: string; toolCallId: string; toolName: string; args?: unknown }
  | { type: 'follow_up_queued'; count: number }
  | { type: 'mode_changed'; modeId: string; previousModeId: string }
  | { type: 'thread_created'; threadId: string; resourceId: string; title?: string }
  | { type: 'thread_renamed'; threadId: string; resourceId: string; title: string }
  | { type: 'thread_deleted'; threadId: string; resourceId: string }
  | { type: 'tree_changed'; tree: HarnessTree }

export type HarnessBusEvent = HarnessEvent | HarnessSessionEvent
export type HarnessListener = (threadId: string, event: HarnessBusEvent) => void

// ── results ──────────────────────────────────────────────────────────────────

export type RunResult =
  | { status: 'done'; text: string; usage?: TokenUsage }
  | { status: 'suspended'; suspension: Suspension & { nodeId: string } }
  | { status: 'error'; error: string; text: string }

export type SendResult = RunResult | { status: 'queued'; queued: number }

// ── engine config (framework-free; tests drive this with fake runners) ───────

export interface SubagentEntry {
  agentType: string
  recall?: boolean
  delegatesTo?: string[]
  maxSteps?: number
  makeRunner: (node: NodeEnvelope, runtime: HarnessRuntime) => AgentRunner
}

// What the per-turn context hook sees: the turn's thread/resource identity, the
// resolved mode (its metadata carries host config like model tiers), and the
// message's attachments — the ONLY server-side seam to them, so a host that
// wants tools to consume attachments stashes them here (the model cannot
// retype a data URL into tool args). Resumes carry no files.
export interface TurnContextArgs {
  threadId: string
  resource: string
  mode?: HarnessMode
  files?: FileAttachment[]
}

export interface EngineConfig {
  supervisorType: string
  registry: Map<string, SubagentEntry>
  maxDepth: number
  resourceFor?: (threadId: string) => string
  modes?: HarnessMode[]
  defaultModeId?: string
  // Called once per turn (fresh runs AND resumes) before the first stream
  // opens; the returned value rides RunOptions.requestContext into EVERY node
  // runner of the turn — supervisor and subagents. Opaque to the engine. A
  // throw here fails the turn before any node starts.
  requestContext?: (args: TurnContextArgs) => unknown | Promise<unknown>
  permissions?: PermissionRules
  toolCategoryResolver?: (toolName: string) => ToolCategory | null
  threads?: ThreadStore
  // Resolves a gated tool call and returns the CONTINUATION stream — Mastra
  // suspends the run on a tool-call-approval chunk and approveToolCall/
  // declineToolCall resume it with a fresh stream the caller must keep driving.
  // requestContext/runtime carry the turn's host context and the node's harness
  // runtime into the continuation — without them the resumed stream would run
  // on an empty RequestContext (default models, no host entries, no built-ins).
  resolveToolCall?: (args: {
    threadId: string
    resourceId: string
    runId: string
    toolCallId: string
    approved: boolean
    message?: string
    requestContext?: unknown
    runtime?: HarnessRuntime
  }) => Promise<StreamResult | undefined>
  // Generates a title from the first user message. Called after a root turn
  // with real input settles on a thread that has none yet; the result is
  // routed through HarnessThreads.rename() so it dispatches thread_renamed.
  generateTitle?: (input: string) => Promise<string | undefined>
}

const SUPPRESS = new Set([DELEGATE_TOOL])

interface GateDecision {
  approved: boolean
  message?: string
  // Set when abort() released the gate — the run is dead; don't resume it.
  aborted?: boolean
}

interface QueuedMessage {
  content: string
  files?: FileAttachment[]
}

interface ThreadState {
  projector: Projector
  queue: QueuedMessage[]
  running: boolean
  abort?: AbortController
  suspensions: Map<string, { runId: string; toolName: string }>
  approvals: Map<string, { toolName: string; resolve: (d: GateDecision) => void }>
  modeId?: string
  modeHydrated: boolean
  grants: { tools: Set<string>; categories: Set<ToolCategory> }
  yolo: boolean
  // The current turn's host context (EngineConfig.requestContext), reachable by
  // #spawnChild so subagent runners receive the same value as the root.
  turnContext?: unknown
}

export class Harness {
  #threads = new Map<string, ThreadState>()
  #listeners = new Set<HarnessListener>()
  #defaultModeId: string | undefined

  readonly threads: HarnessThreads

  constructor(private cfg: EngineConfig) {
    this.#defaultModeId =
      cfg.defaultModeId ??
      cfg.modes?.find((m) => m.metadata?.default === true)?.id ??
      cfg.modes?.[0]?.id
    if (cfg.defaultModeId && !cfg.modes?.some((m) => m.id === cfg.defaultModeId))
      throw new Error(`defaultModeId '${cfg.defaultModeId}' is not a configured mode`)
    this.threads = new HarnessThreads(
      cfg.threads,
      (threadId, e) => this.#dispatch(threadId, e),
      (threadId) => {
        // Quiesce before dropping state — an orphaned in-flight turn would
        // lazily recreate a fresh ThreadState and interleave with a new thread.
        this.abort(threadId)
        this.#threads.delete(threadId)
      },
    )
  }

  // ── bus ────────────────────────────────────────────────────────────────────

  subscribe(listener: HarnessListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getTree(threadId: string): HarnessTree | undefined {
    return this.#threads.get(threadId)?.projector.tree
  }

  // Pipeline per node event: fold first, then the raw event, then a synthetic
  // tree_changed — so a listener can consume deltas OR just re-render snapshots.
  #emitNode(threadId: string, event: HarnessEvent): void {
    const st = this.#state(threadId)
    st.projector.emit(event)
    this.#dispatch(threadId, event)
    this.#dispatch(threadId, { type: 'tree_changed', tree: st.projector.tree })
  }

  #dispatch(threadId: string, event: HarnessBusEvent): void {
    for (const l of this.#listeners) {
      try {
        l(threadId, event)
      } catch (e) {
        console.error('[harness] listener failed', e)
      }
    }
  }

  // ── message loop ───────────────────────────────────────────────────────────

  async sendMessage(args: { threadId: string; content: string; files?: FileAttachment[] }): Promise<SendResult> {
    const st = this.#state(args.threadId)
    if (st.running) {
      st.queue.push({ content: args.content, files: args.files })
      this.#dispatch(args.threadId, { type: 'follow_up_queued', count: st.queue.length })
      return { status: 'queued', queued: st.queue.length }
    }
    return this.#runTurn(args.threadId, args.content, args.files)
  }

  // Abort the running turn, drop the queue, and jump the new message in.
  async steer(args: { threadId: string; content: string; files?: FileAttachment[] }): Promise<SendResult> {
    const st = this.#state(args.threadId)
    this.abort(args.threadId)
    st.queue = []
    this.#dispatch(args.threadId, { type: 'follow_up_queued', count: 0 })
    return this.sendMessage(args)
  }

  abort(threadId: string): void {
    const st = this.#threads.get(threadId)
    if (!st) return
    // Release every parking spot: pending approval gates resolve as aborted
    // (so the drive loop does NOT resume the dead run), parked suspensions and
    // the follow-up queue are dropped — abort means stop everything.
    for (const gate of st.approvals.values()) gate.resolve({ approved: false, aborted: true })
    st.approvals.clear()
    // A PARKED suspension's node never got a node_end (the turn already
    // returned) — settle it in the tree, or every client sees a phantom
    // running turn (and a phantom pending ask) forever.
    if (!st.running) {
      for (const runId of new Set([...st.suspensions.values()].map((s) => s.runId))) {
        this.#emitNode(threadId, {
          nodeId: runId,
          parentNodeId: null,
          depth: 0,
          agentType: this.cfg.supervisorType,
          type: 'node_end',
          reason: 'aborted',
        })
      }
    }
    st.suspensions.clear()
    if (st.queue.length > 0) {
      st.queue = []
      this.#dispatch(threadId, { type: 'follow_up_queued', count: 0 })
    }
    st.abort?.abort()
  }

  // Validation is synchronous (throws before any await) so a transport binding
  // can reject fast and fire-and-forget the returned turn promise.
  resume(args: { threadId: string; toolCallId?: string; resumeData: unknown }): Promise<SendResult> {
    const st = this.#state(args.threadId)
    if (st.running) throw new Error(`thread ${args.threadId} is mid-turn; cannot resume until it settles`)
    const toolCallId = this.#resolveParked(st.suspensions, args.toolCallId, 'suspension')
    const suspension = st.suspensions.get(toolCallId)!
    st.suspensions.delete(toolCallId)
    const node: NodeEnvelope = { nodeId: suspension.runId, parentNodeId: null, depth: 0, agentType: this.cfg.supervisorType }
    return this.#drive(args.threadId, node, '', false, args.resumeData)
  }

  async #runTurn(threadId: string, content: string, files?: FileAttachment[]): Promise<RunResult> {
    const node: NodeEnvelope = { nodeId: nanoid(), parentNodeId: null, depth: 0, agentType: this.cfg.supervisorType }
    return this.#drive(threadId, node, content, true, undefined, files)
  }

  async #drive(
    threadId: string,
    node: NodeEnvelope,
    input: string,
    emitStart: boolean,
    resumeData?: unknown,
    files?: FileAttachment[],
  ): Promise<RunResult> {
    const st = this.#state(threadId)
    st.running = true
    st.abort = new AbortController()
    try {
      const entry = this.#entry(this.cfg.supervisorType)
      const runtime = this.#makeRuntime(threadId, node)
      const resource = this.#resource(threadId)
      // A fresh thread's first send materializes it in the store. Mastra would
      // lazily auto-create it on message save, but silently — no thread_created
      // on the bus, so durable sinks never learn resourceId/createdAt. Resumes
      // skip this (input === ''): a parked suspension implies the thread exists.
      if (input && this.cfg.threads) {
        const existing = await this.threads.get(threadId)
        if (!existing) await this.threads.create({ threadId, resourceId: resource })
      }
      let mode: HarnessMode | undefined
      try {
        mode = await this.#currentMode(threadId)
        // Resolved per turn — resumes included, so a host that builds per-turn
        // state (credentials, toolsets, renderers) rebuilds it here too.
        st.turnContext = await this.cfg.requestContext?.({ threadId, resource, mode, files })
      } catch (err) {
        // A pre-node failure must land in the tree — the wire fires sendMessage
        // without awaiting it, so without these events the message just vanishes
        // for every client. Announce, settle as errored, rethrow for in-process
        // callers.
        const message = err instanceof Error ? err.message : String(err)
        if (emitStart) this.#emitNode(threadId, { ...node, type: 'node_start', task: input || undefined })
        this.#emitNode(threadId, { ...node, type: 'error', message })
        this.#emitNode(threadId, { ...node, type: 'node_end', reason: 'error' })
        throw err
      }
      const run: RunOptions = {
        input,
        threadId,
        resource,
        maxSteps: entry.maxSteps,
        abortSignal: st.abort.signal,
        resumeData,
        files,
        requestContext: st.turnContext,
        modeInstructions: mode?.instructions,
        activeTools: mode?.availableTools,
        requireApproval: this.#approvalPredicate(threadId),
      }
      let runner = entry.makeRunner(node, runtime)
      let text = ''
      // A turn may span several streams: each gated tool call suspends the run
      // (the stream closes); approveToolCall/declineToolCall return the
      // continuation stream and we keep driving the SAME node.
      for (;;) {
        const res = await runNode({
          runner,
          envelope: node,
          run,
          emit: (e) => this.#emitNode(threadId, e),
          suppressToolNames: SUPPRESS,
          emitStart,
          task: input || undefined,
        })
        text += res.text
        if (res.approval) {
          const decision = await this.#decideApproval(threadId, node.nodeId, res.approval)
          if (decision.aborted) {
            // The stream closed on the approval chunk with no node_end and no
            // continuation is coming — settle the node in the tree.
            this.#emitNode(threadId, { ...node, type: 'node_end', reason: 'aborted' })
            return { status: 'error', error: 'aborted', text }
          }
          const continuation = await this.cfg.resolveToolCall?.({
            threadId,
            resourceId: run.resource,
            runId: node.nodeId,
            toolCallId: res.approval.toolCallId,
            approved: decision.approved,
            message: decision.message,
            requestContext: st.turnContext,
            runtime,
          })
          if (!continuation) return { status: 'done', text, usage: res.usage }
          runner = async () => continuation
          run.resumeData = undefined
          emitStart = false
          continue
        }
        if (res.suspended) {
          const suspension = { ...res.suspended, nodeId: node.nodeId }
          st.suspensions.set(res.suspended.toolCallId, { runId: node.nodeId, toolName: res.suspended.toolName })
          this.#dispatch(threadId, {
            type: 'suspended',
            nodeId: node.nodeId,
            toolCallId: res.suspended.toolCallId,
            toolName: res.suspended.toolName,
            request: res.suspended.suspendPayload,
            resumeSchema: res.suspended.resumeSchema,
          })
          return { status: 'suspended', suspension: { ...suspension } }
        }
        if (res.error) return { status: 'error', error: res.error, text }
        return { status: 'done', text, usage: res.usage }
      }
    } finally {
      st.running = false
      if (input) void this.#maybeGenerateTitle(threadId, input)
      this.#drainQueue(threadId)
    }
  }

  // Fire-and-forget: only the FIRST turn on a thread lacks a title, so this
  // is a cheap no-op read on every later settle. Two turns racing on the same
  // thread (a queued follow-up starting before this resolves) can both pass
  // the !title check — last write wins, an extra thread_renamed event, no
  // corruption. Accepted at this scale; not worth a lock.
  async #maybeGenerateTitle(threadId: string, input: string): Promise<void> {
    if (!this.cfg.generateTitle || !this.cfg.threads) return
    try {
      const thread = await this.cfg.threads.getThreadById({ threadId })
      if (!thread || thread.title) return
      const title = await this.cfg.generateTitle(input)
      if (title) await this.threads.rename(threadId, title)
    } catch (e) {
      console.error('[harness] title generation failed', e)
    }
  }

  #drainQueue(threadId: string): void {
    const st = this.#threads.get(threadId)
    const next = st?.queue.shift()
    if (next === undefined) return
    this.#dispatch(threadId, { type: 'follow_up_queued', count: st!.queue.length })
    void this.sendMessage({ threadId, content: next.content, files: next.files }).catch((e) =>
      console.error('[harness] queued follow-up failed', e),
    )
  }

  // ── delegation (unchanged mechanics, edges enforced) ───────────────────────

  #makeRuntime(threadId: string, node: NodeEnvelope): HarnessRuntime {
    return {
      node,
      emit: (e) => this.#emitNode(threadId, e),
      delegate: (agentType, task, toolCallId) => this.#spawnChild(threadId, agentType, task, toolCallId, node),
    }
  }

  async #spawnChild(
    threadId: string,
    agentType: string,
    task: string,
    toolCallId: string,
    parent: NodeEnvelope,
  ): Promise<{ content: string; isError: boolean }> {
    // Subagent nodes run headless: no approval gating, no mode overlay — same
    // policy as AgentController (children get constrained tools, not gates).
    const entry = this.cfg.registry.get(agentType)
    if (!entry) return { content: `unknown subagent: ${agentType}`, isError: true }
    const allowed = this.cfg.registry.get(parent.agentType ?? '')?.delegatesTo ?? []
    if (!allowed.includes(agentType))
      return { content: `'${parent.agentType}' may not delegate to '${agentType}'`, isError: true }
    const depth = parent.depth + 1
    if (depth > this.cfg.maxDepth) return { content: `max delegation depth (${this.cfg.maxDepth}) reached`, isError: true }

    const node: NodeEnvelope = { nodeId: toolCallId, parentNodeId: parent.nodeId, depth, agentType }
    const childThread = entry.recall ? `${threadId}:${agentType}` : toolCallId
    const runtime = this.#makeRuntime(threadId, node)
    const res = await runNode({
      runner: entry.makeRunner(node, runtime),
      envelope: node,
      run: {
        input: task,
        threadId: childThread,
        resource: this.#resource(threadId),
        maxSteps: entry.maxSteps,
        abortSignal: this.#threads.get(threadId)?.abort?.signal,
        requestContext: this.#threads.get(threadId)?.turnContext,
      },
      emit: (e) => this.#emitNode(threadId, e),
      suppressToolNames: SUPPRESS,
      task,
    })
    return { content: res.text || '(no output)', isError: !!res.error }
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  #approvalsConfigured(): boolean {
    return !!(this.cfg.permissions || this.cfg.toolCategoryResolver)
  }

  // The predicate handed to Mastra's requireToolApproval: gate everything that
  // doesn't resolve to 'allow' ('deny' also gates — the gate auto-declines it).
  #approvalPredicate(threadId: string): ((toolName: string) => boolean) | undefined {
    if (!this.#approvalsConfigured()) return undefined
    return (toolName) => this.resolveToolApproval(threadId, toolName) !== 'allow'
  }

  resolveToolApproval(threadId: string, toolName: string): PermissionPolicy {
    if (BUILTIN_TOOLS.has(toolName)) return 'allow'
    const st = this.#state(threadId)
    const rules = this.cfg.permissions ?? {}
    const toolPolicy = rules.tools?.[toolName]
    if (toolPolicy === 'deny') return 'deny' // explicit per-tool deny beats yolo
    if (st.yolo) return 'allow'
    if (toolPolicy) return toolPolicy
    if (st.grants.tools.has(toolName)) return 'allow'
    const category = this.cfg.toolCategoryResolver?.(toolName)
    if (category) {
      if (st.grants.categories.has(category)) return 'allow'
      const categoryPolicy = rules.categories?.[category]
      if (categoryPolicy) return categoryPolicy
    }
    return 'ask'
  }

  setYolo(threadId: string, yolo: boolean): void {
    this.#state(threadId).yolo = yolo
  }

  async respondToApproval(args: {
    threadId: string
    toolCallId?: string
    decision: ApprovalDecision
    message?: string
  }): Promise<void> {
    const st = this.#state(args.threadId)
    const toolCallId = this.#resolveParked(st.approvals, args.toolCallId, 'approval')
    const gate = st.approvals.get(toolCallId)!
    st.approvals.delete(toolCallId)
    if (args.decision === 'always_allow') st.grants.tools.add(gate.toolName)
    if (args.decision === 'always_allow_category') {
      const cat = this.cfg.toolCategoryResolver?.(gate.toolName)
      if (cat) st.grants.categories.add(cat)
      else st.grants.tools.add(gate.toolName)
    }
    const approved = args.decision !== 'decline'
    gate.resolve({ approved, message: args.message })
  }

  async #decideApproval(threadId: string, nodeId: string, req: ApprovalRequest): Promise<GateDecision> {
    const st = this.#state(threadId)
    const policy = this.resolveToolApproval(threadId, req.toolName)
    if (policy === 'allow') return { approved: true }
    if (policy === 'deny') return { approved: false, message: `tool '${req.toolName}' is denied by permission rules` }
    // Arm the gate BEFORE emitting — a listener may respond synchronously.
    const gate = new Promise<GateDecision>((resolve) =>
      st.approvals.set(req.toolCallId, { toolName: req.toolName, resolve }),
    )
    this.#dispatch(threadId, { type: 'approval_required', nodeId, ...req })
    return gate
  }

  // ── modes ──────────────────────────────────────────────────────────────────

  listModes(): HarnessMode[] {
    return this.cfg.modes ?? []
  }

  get defaultModeId(): string | undefined {
    return this.#defaultModeId
  }

  getMode(threadId: string): string | undefined {
    return this.#threads.get(threadId)?.modeId ?? this.#defaultModeId
  }

  async switchMode(threadId: string, modeId: string): Promise<void> {
    if (!this.cfg.modes?.some((m) => m.id === modeId)) throw new Error(`unknown mode: ${modeId}`)
    const st = this.#state(threadId)
    const previousModeId = this.getMode(threadId) ?? ''
    st.modeId = modeId
    st.modeHydrated = true
    this.#dispatch(threadId, { type: 'mode_changed', modeId, previousModeId })
    // Persist per-thread so a restart resumes in the same mode. Best-effort.
    if (this.cfg.threads) {
      try {
        const thread = await this.cfg.threads.getThreadById({ threadId })
        if (thread)
          await this.cfg.threads.saveThread({
            thread: { ...thread, metadata: { ...thread.metadata, harnessModeId: modeId } },
          })
      } catch (e) {
        console.error('[harness] mode persistence failed', e)
      }
    }
  }

  async #currentMode(threadId: string): Promise<HarnessMode | undefined> {
    if (!this.cfg.modes?.length) return undefined
    const st = this.#state(threadId)
    if (!st.modeHydrated) {
      st.modeHydrated = true
      if (!st.modeId && this.cfg.threads) {
        const persisted = await this.cfg.threads
          .getThreadById({ threadId })
          .then((t) => t?.metadata?.harnessModeId)
          .catch(() => undefined)
        // Re-check after the await — a switchMode may have landed meanwhile,
        // and a stale persisted value must not clobber it.
        if (!st.modeId && typeof persisted === 'string' && this.cfg.modes.some((m) => m.id === persisted))
          st.modeId = persisted
      }
    }
    const id = st.modeId ?? this.#defaultModeId
    return this.cfg.modes.find((m) => m.id === id)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  #resolveParked(map: Map<string, unknown>, toolCallId: string | undefined, kind: string): string {
    if (toolCallId) {
      if (!map.has(toolCallId)) throw new Error(`no parked ${kind} for toolCallId ${toolCallId}`)
      return toolCallId
    }
    if (map.size === 1) return map.keys().next().value as string
    if (map.size === 0) throw new Error(`no parked ${kind} to respond to`)
    throw new Error(`multiple parked ${kind}s — specify toolCallId (${[...map.keys()].join(', ')})`)
  }

  #entry(agentType: string): SubagentEntry {
    const e = this.cfg.registry.get(agentType)
    if (!e) throw new Error(`agent not registered: ${agentType}`)
    return e
  }

  #state(threadId: string): ThreadState {
    let st = this.#threads.get(threadId)
    if (!st) {
      st = {
        projector: new Projector(),
        queue: [],
        running: false,
        suspensions: new Map(),
        approvals: new Map(),
        modeHydrated: false,
        grants: { tools: new Set(), categories: new Set() },
        yolo: false,
      }
      this.#threads.set(threadId, st)
    }
    return st
  }

  #resource(threadId: string): string {
    return this.cfg.resourceFor?.(threadId) ?? threadId
  }
}

// ── thread facade ─────────────────────────────────────────────────────────────

export class HarnessThreads {
  constructor(
    private store: ThreadStore | undefined,
    private dispatch: (threadId: string, e: HarnessSessionEvent) => void,
    private teardown: (threadId: string) => void,
  ) {}

  #require(): ThreadStore {
    if (!this.store) throw new Error('thread management requires a memory/threads store on the harness config')
    return this.store
  }

  async list(resourceId?: string): Promise<ThreadInfo[]> {
    const out = await this.#require().listThreads({ perPage: false, filter: resourceId ? { resourceId } : undefined })
    return out.threads.map(toThreadInfo)
  }

  async get(threadId: string): Promise<ThreadInfo | null> {
    const t = await this.#require().getThreadById({ threadId })
    return t ? toThreadInfo(t) : null
  }

  async create(args: { threadId?: string; resourceId?: string; title?: string } = {}): Promise<ThreadInfo> {
    const threadId = args.threadId ?? nanoid()
    const t = await this.#require().createThread({
      threadId,
      resourceId: args.resourceId ?? threadId,
      title: args.title,
    })
    this.dispatch(t.id, { type: 'thread_created', threadId: t.id, resourceId: t.resourceId, title: t.title })
    return toThreadInfo(t)
  }

  async rename(threadId: string, title: string): Promise<void> {
    const store = this.#require()
    const thread = await store.getThreadById({ threadId })
    if (!thread) throw new Error(`thread not found: ${threadId}`)
    await store.saveThread({ thread: { ...thread, title } })
    this.dispatch(threadId, { type: 'thread_renamed', threadId, resourceId: thread.resourceId, title })
  }

  async delete(threadId: string): Promise<void> {
    // Read the resourceId before deleting — the resource-room broadcast needs it
    // to reach the right tabs, and the row is gone after deleteThread.
    const thread = await this.#require().getThreadById({ threadId })
    try {
      await this.#require().deleteThread(threadId)
    } catch (e) {
      // Some stores delete the row then throw on a secondary cleanup: Mastra's
      // PostgresStore clears observational memory on every deleteThread, but that
      // table is created lazily on first write — so deleting a thread that never
      // wrote one throws AFTER the row is already gone. If the thread is verifiably
      // gone the delete succeeded for our purposes; only re-throw a genuine failure
      // that left it in place (otherwise thread_deleted never fires and every
      // client's sidebar silently keeps the dead thread).
      if (await this.#require().getThreadById({ threadId })) throw e
    }
    this.teardown(threadId)
    this.dispatch(threadId, { type: 'thread_deleted', threadId, resourceId: thread?.resourceId ?? threadId })
  }
}

function toThreadInfo(t: ThreadRecord): ThreadInfo {
  return {
    id: t.id,
    resourceId: t.resourceId,
    title: t.title,
    createdAt: toIso(t.createdAt),
    updatedAt: toIso(t.updatedAt),
  }
}

function toIso(d: Date | string | undefined): string | undefined {
  if (d === undefined) return undefined
  return typeof d === 'string' ? d : d.toISOString()
}

// ── Mastra-first factory ─────────────────────────────────────────────────────

export interface SubagentConfig {
  agent: Agent
  // Who this agent may delegate to: agent ids, `true` = every registered agent.
  // Default: none (leaf).
  delegatesTo?: string[] | true
  recall?: boolean
  maxSteps?: number
}

export interface HarnessConfig {
  supervisor: Agent
  // Supervisor delegatesTo defaults to ALL subagents; override to restrict.
  delegatesTo?: string[] | true
  subagents?: SubagentConfig[]
  // Root-turn step budget for the supervisor (Mastra's `maxSteps`). Unset =
  // Mastra's default (~5), which caps a multi-step plan-and-execute turn.
  // Subagents set theirs via SubagentConfig.maxSteps.
  maxSteps?: number
  maxDepth?: number
  modes?: HarnessMode[]
  defaultModeId?: string
  // Enables harness.threads.* and per-thread mode persistence. A MastraMemory
  // instance fits structurally.
  memory?: ThreadStore
  resourceFor?: (threadId: string) => string
  permissions?: PermissionRules
  toolCategoryResolver?: (toolName: string) => ToolCategory | null
  // Auto-titles a thread from its first message via the supervisor's own
  // generateTitleFromUserMessage — the harness relays the result as
  // thread_renamed instead of the title landing silently in Mastra storage.
  generateTitle?: boolean | { model?: MastraModelConfig; instructions?: string }
  // Build the turn's host RequestContext (credentials, per-turn toolsets,
  // mode-driven model config via args.mode.metadata). Called once per turn —
  // resumes included — and its entries are copied into every node's
  // RequestContext, supervisor and subagents alike, beneath the harness
  // runtime key. Return a fresh instance each call.
  requestContext?: (args: TurnContextArgs) => RequestContext | undefined | Promise<RequestContext | undefined>
}

export function createHarness(config: HarnessConfig): Harness {
  const subs = config.subagents ?? []
  const subTypes = subs.map((s) => s.agent.id)
  const known = new Set([config.supervisor.id, ...subTypes])

  const resolveEdges = (d: string[] | true | undefined, fallback: string[]): string[] => {
    const edges = d === true ? [...known] : (d ?? fallback)
    for (const t of edges) if (!known.has(t)) throw new Error(`delegatesTo references unregistered agent '${t}'`)
    return edges
  }

  const runnerFactory = (agent: Agent, delegatesTo: string[]) => {
    const delegateTool = delegatesTo.length > 0 ? makeDelegateTool(delegatesTo) : undefined
    return (node: NodeEnvelope, runtime: HarnessRuntime): AgentRunner =>
      async (opts) => {
        // Copy the turn's host context into a per-node instance — the runtime
        // key differs per node, so sibling nodes must not share one context.
        const host = opts.requestContext as RequestContext | undefined
        const rc = new RequestContext<Record<string, unknown>>(host ? [...host.entries()] : undefined)
        rc.set(HARNESS_RUNTIME_KEY, runtime)
        const tools: Record<string, unknown> = { todo: todoTool }
        if (node.depth === 0) tools.ask_user = askUserTool // root-only HITL
        if (delegateTool) tools.delegate = delegateTool
        const streamOpts: Record<string, unknown> = {
          // Key Mastra's run by the node id so a parked suspension/approval can
          // be resumed later (resumeStream/approveToolCall look it up by runId).
          runId: node.nodeId,
          memory: { thread: opts.threadId, resource: opts.resource },
          toolsets: { harness: tools as ToolsInput },
          maxSteps: opts.maxSteps,
          abortSignal: opts.abortSignal,
          requestContext: rc,
        }
        if (opts.modeInstructions) streamOpts.instructions = await layerInstructions(agent, opts.modeInstructions)
        // A mode allowlist must never hide the harness built-ins.
        if (opts.activeTools) streamOpts.activeTools = [...new Set([...opts.activeTools, ...Object.keys(tools)])]
        if (opts.requireApproval) {
          const gate = opts.requireApproval
          streamOpts.requireToolApproval = (ctx: { toolName: string }) => gate(ctx.toolName)
        }
        // Attachments fold into the user message: image/* (or no mimeType) as
        // image parts, everything else as file parts (the wire's mimeType is
        // the AI SDK's mediaType). An attachment-only send has no text part —
        // providers reject empty text blocks.
        const input = opts.files?.length
          ? [
              {
                role: 'user' as const,
                content: [
                  ...(opts.input ? [{ type: 'text' as const, text: opts.input }] : []),
                  ...opts.files.map((f) =>
                    !f.mimeType || f.mimeType.startsWith('image/')
                      ? { type: 'image' as const, image: f.url, mediaType: f.mimeType }
                      : { type: 'file' as const, data: f.url, mediaType: f.mimeType },
                  ),
                ],
              },
            ]
          : opts.input
        const out =
          opts.resumeData !== undefined
            ? await agent.resumeStream(opts.resumeData, streamOpts as never)
            : await agent.stream(input, streamOpts as never)
        return out as unknown as StreamResult
      }
  }

  const registry = new Map<string, SubagentEntry>()
  const supervisorEdges = resolveEdges(config.delegatesTo, subTypes)
  registry.set(config.supervisor.id, {
    agentType: config.supervisor.id,
    delegatesTo: supervisorEdges,
    maxSteps: config.maxSteps,
    makeRunner: runnerFactory(config.supervisor, supervisorEdges),
  })
  for (const s of subs) {
    const edges = resolveEdges(s.delegatesTo, [])
    registry.set(s.agent.id, {
      agentType: s.agent.id,
      recall: s.recall,
      delegatesTo: edges,
      maxSteps: s.maxSteps,
      makeRunner: runnerFactory(s.agent, edges),
    })
  }

  return new Harness({
    supervisorType: config.supervisor.id,
    registry,
    maxDepth: config.maxDepth ?? 3,
    resourceFor: config.resourceFor,
    modes: config.modes,
    defaultModeId: config.defaultModeId,
    permissions: config.permissions,
    toolCategoryResolver: config.toolCategoryResolver,
    threads: config.memory,
    requestContext: config.requestContext,
    resolveToolCall: async ({ runId, toolCallId, approved, requestContext, runtime }) => {
      // Rebuild the continuation's RequestContext the same way the runner does —
      // Mastra resumes with the OPTIONS given here, not the original stream's, so
      // omitting it would resolve default models and drop every host entry.
      const host = requestContext as RequestContext | undefined
      const rc = new RequestContext<Record<string, unknown>>(host ? [...host.entries()] : undefined)
      if (runtime) rc.set(HARNESS_RUNTIME_KEY, runtime)
      const callOpts = { runId, toolCallId, requestContext: rc }
      const out = approved
        ? await config.supervisor.approveToolCall(callOpts as never)
        : await config.supervisor.declineToolCall(callOpts as never)
      return out as unknown as StreamResult
    },
    generateTitle: config.generateTitle
      ? (input: string) => {
          const opts = typeof config.generateTitle === 'object' ? config.generateTitle : undefined
          return config.supervisor.generateTitleFromUserMessage({ message: input, model: opts?.model, instructions: opts?.instructions })
        }
      : undefined,
  })
}

// Mode instructions LAYER onto the agent's own (string instructions only —
// structured instruction shapes fall back to the mode text alone).
async function layerInstructions(agent: Agent, modeInstructions: string): Promise<string> {
  const base = await Promise.resolve(agent.getInstructions()).catch(() => undefined)
  return typeof base === 'string' ? `${base}\n\n${modeInstructions}` : modeInstructions
}
