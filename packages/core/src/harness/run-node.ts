// Runs ONE node's model turn: drives an AgentRunner's fullStream, folds each
// chunk into enveloped HarnessEvents via the shared mapper, and returns the
// node's final text + usage (or a suspension). Decoupled from Mastra's Agent
// type via the AgentRunner seam, so both a real `agent.stream` and a fake
// (self-check) drive it identically.

import type { HarnessEvent, TokenUsage } from '@super-harness/shared'
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
}

export type AgentRunner = (opts: RunOptions) => Promise<StreamResult>

export interface NodeEnvelope {
  nodeId: string
  parentNodeId: string | null
  depth: number
  agentType?: string
}

export interface RunNodeResult {
  text: string
  usage?: TokenUsage
  suspended?: Suspension
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
    for await (const chunk of fullStream) {
      for (const body of adapter.map(chunk)) {
        if (body.type === 'text_delta') text += body.text
        emit(stamp(body))
      }
    }
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
