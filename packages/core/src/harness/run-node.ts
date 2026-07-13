// Runs ONE node's model turn: drives an AgentRunner's fullStream, folds each
// chunk into enveloped HarnessEvents via the shared mapper, and returns the
// node's final text + usage (or a suspension). Decoupled from Mastra's Agent
// type via the AgentRunner seam, so both a real `agent.stream` and a fake
// (self-check) drive it identically.

import type { TracingContext } from '@mastra/core/observability'
import type { FileAttachment, HarnessEvent, TokenUsage } from '@super-harness/shared'
import { createChunkAdapter, type ChunkLike, type Suspension } from './chunk-adapter'

export interface StreamResult {
  fullStream: AsyncIterable<ChunkLike>
}

export interface RunOptions {
  input: string
  threadId: string
  resource: string
  maxSteps?: number
  abortSignal?: AbortSignal
  // When set, the runner resumes a suspended tool (agent.resumeStream) instead
  // of starting a fresh turn (agent.stream).
  resumeData?: unknown
  // Mode overlay for this turn (root node only): instructions layered onto the
  // agent's own, and an activeTools allowlist.
  modeInstructions?: string
  activeTools?: string[]
  // Per-call approval predicate (root node only). When set, the runner passes it
  // as Mastra's requireToolApproval; gated calls surface as tool-call-approval
  // chunks handled via runNode's onApproval.
  requireApproval?: (toolName: string) => boolean
  // The turn's host context (EngineConfig.requestContext) — opaque here; the
  // Mastra runner copies its entries into the node's RequestContext beneath the
  // harness runtime key. Same value for every node of the turn.
  requestContext?: unknown
  // The turn's trace id — minted once per turn and threaded to EVERY node
  // (supervisor + children) as Mastra tracingOptions.traceId, so a whole turn
  // lands in ONE trace even when Mastra doesn't hand the delegate tool a live
  // span (ambient span propagation does NOT cross into the child stream).
  traceId?: string
  // The parent delegate tool-call's tracing context (its currentSpan is the
  // delegate TOOL_CALL span). When present, runnerFactory adds parentSpanId so
  // the child's AGENT_RUN span nests UNDER that span; when absent, the traceId
  // above still keeps the child in the same trace (as a sibling root).
  tracingContext?: TracingContext
  // Attachments folded into the user message (root turns only): image/* as
  // image parts, other mimeTypes as file parts.
  files?: FileAttachment[]
}

export type AgentRunner = (opts: RunOptions) => Promise<StreamResult>

export interface NodeEnvelope {
  nodeId: string
  parentNodeId: string | null
  depth: number
  agentType?: string
}

export interface ApprovalRequest {
  toolCallId: string
  toolName: string
  args?: unknown
}

export interface RunNodeResult {
  text: string
  usage?: TokenUsage
  suspended?: Suspension
  // The stream parked on a tool-call-approval chunk and CLOSED (Mastra suspends
  // the run). The caller resolves it via approveToolCall/declineToolCall, which
  // return a continuation stream to drive through runNode again (emitStart: false).
  approval?: ApprovalRequest
  error?: string
}

export async function runNode(args: {
  runner: AgentRunner
  envelope: NodeEnvelope
  run: RunOptions
  emit: (e: HarnessEvent) => void
  suppressToolNames?: ReadonlySet<string>
  task?: string
  modelId?: string
  // false on resume — the node already exists, don't re-announce it.
  emitStart?: boolean
}): Promise<RunNodeResult> {
  const { runner, envelope, run, emit, task, modelId } = args
  const suppress = args.suppressToolNames ?? new Set<string>()
  const stamp = (body: Record<string, unknown>): HarnessEvent => ({ ...envelope, ...body }) as HarnessEvent
  const started = Date.now()
  let text = ''

  if (args.emitStart !== false) emit(stamp({ type: 'node_start', task, modelId }))
  const adapter = createChunkAdapter(suppress)

  try {
    const { fullStream } = await runner(run)
    let approval: ApprovalRequest | undefined
    for await (const chunk of fullStream) {
      if (chunk.type === 'tool-call-approval') {
        // Mastra suspends the run here and the stream closes — park it. No
        // node_end: the caller resolves the approval and continues this node.
        const p = (chunk.payload ?? {}) as Record<string, unknown>
        approval = { toolCallId: String(p.toolCallId ?? ''), toolName: String(p.toolName ?? ''), args: p.args }
        break
      }
      for (const body of adapter.map(chunk)) {
        if (body.type === 'text_delta') text += body.text
        emit(stamp(body))
      }
    }
    if (approval) return { text, usage: adapter.usage, approval }
  } catch (err) {
    if (run.abortSignal?.aborted) {
      emit(stamp({ type: 'node_end', reason: 'aborted' }))
      return { text, error: 'aborted' }
    }
    const message = err instanceof Error ? err.message : String(err)
    emit(stamp({ type: 'error', message }))
    emit(stamp({ type: 'node_end', reason: 'error' }))
    return { text, error: message }
  }

  if (adapter.suspension) {
    // Parked on a suspending tool (ask_user): no node_end — the turn resumes
    // into the SAME node/tree via session.resume.
    return { text, usage: adapter.usage, suspended: adapter.suspension }
  }

  emit(stamp({ type: 'node_end', reason: 'complete', usage: adapter.usage, durationMs: Date.now() - started }))
  return { text, usage: adapter.usage }
}
