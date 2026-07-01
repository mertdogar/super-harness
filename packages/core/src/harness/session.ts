// Turn orchestrator. Mastra-agnostic: it drives nodes through RunnerFactories
// (a real one wraps agent.stream; the self-check passes a fake), folds their
// events into the per-conversation Projector -> Store, and recurses on delegate.
// Root-only HITL: a suspension parks the turn; resume re-enters the same root.

import { nanoid } from 'nanoid'
import type { Suspension } from './chunk-adapter'
import type { TreeSink } from './sink'
import { Projector } from './projector'
import { runNode, type AgentRunner, type NodeEnvelope } from './run-node'
import { DELEGATE_TOOL, type HarnessRuntime } from './runtime'

export interface SubagentEntry {
  agentType: string
  recall?: boolean
  canDelegate?: boolean
  maxSteps?: number
  makeRunner: (node: NodeEnvelope, runtime: HarnessRuntime) => AgentRunner
}

export interface SessionConfig {
  supervisorType: string
  registry: Map<string, SubagentEntry>
  maxDepth: number
  sinkFor: (threadId: string) => TreeSink
  resourceFor?: (threadId: string) => string
  onSuspended?: (threadId: string, s: Suspension & { nodeId: string }) => void
}

const SUPPRESS = new Set([DELEGATE_TOOL])

export class Session {
  private projectors = new Map<string, Projector>()
  private active = new Map<string, { runId: string; abort: AbortController }>()

  constructor(private cfg: SessionConfig) {}

  async run(threadId: string, message: string): Promise<void> {
    const runId = nanoid()
    const abort = new AbortController()
    this.active.set(threadId, { runId, abort })
    const node: NodeEnvelope = { nodeId: runId, parentNodeId: null, depth: 0, agentType: this.cfg.supervisorType }
    await this.drive(threadId, node, message, abort.signal, true)
  }

  async resume(threadId: string, resumeData: unknown): Promise<void> {
    const act = this.active.get(threadId)
    if (!act) throw new Error(`no active turn to resume for thread ${threadId}`)
    const node: NodeEnvelope = { nodeId: act.runId, parentNodeId: null, depth: 0, agentType: this.cfg.supervisorType }
    await this.drive(threadId, node, '', act.abort.signal, false, resumeData)
  }

  abort(threadId: string): void {
    this.active.get(threadId)?.abort.abort()
    this.active.delete(threadId)
  }

  private async drive(
    threadId: string,
    node: NodeEnvelope,
    input: string,
    signal: AbortSignal,
    emitStart: boolean,
    resumeData?: unknown,
  ): Promise<void> {
    const entry = this.entry(this.cfg.supervisorType)
    const runtime = this.makeRuntime(threadId, node)
    const res = await runNode({
      runner: entry.makeRunner(node, runtime),
      envelope: node,
      run: { input, threadId, resource: this.resource(threadId), abortSignal: signal, resumeData },
      emit: (e) => this.projector(threadId).emit(e),
      suppressToolNames: SUPPRESS,
      emitStart,
    })
    if (res.suspended) {
      this.cfg.onSuspended?.(threadId, { ...res.suspended, nodeId: node.nodeId })
      return
    }
    this.active.delete(threadId)
  }

  private makeRuntime(threadId: string, node: NodeEnvelope): HarnessRuntime {
    return {
      node,
      emit: (e) => this.projector(threadId).emit(e),
      delegate: (agentType, task, toolCallId) => this.spawnChild(threadId, agentType, task, toolCallId, node),
    }
  }

  private async spawnChild(
    threadId: string,
    agentType: string,
    task: string,
    toolCallId: string,
    parent: NodeEnvelope,
  ): Promise<{ content: string; isError: boolean }> {
    const entry = this.cfg.registry.get(agentType)
    if (!entry) return { content: `unknown subagent: ${agentType}`, isError: true }
    const depth = parent.depth + 1
    if (depth > this.cfg.maxDepth) return { content: `max delegation depth (${this.cfg.maxDepth}) reached`, isError: true }

    const node: NodeEnvelope = { nodeId: toolCallId, parentNodeId: parent.nodeId, depth, agentType }
    const childThread = entry.recall ? `${threadId}:${agentType}` : toolCallId
    const runtime = this.makeRuntime(threadId, node)
    const res = await runNode({
      runner: entry.makeRunner(node, runtime),
      envelope: node,
      run: {
        input: task,
        threadId: childThread,
        resource: this.resource(threadId),
        maxSteps: entry.maxSteps,
        abortSignal: this.active.get(threadId)?.abort.signal,
      },
      emit: (e) => this.projector(threadId).emit(e),
      suppressToolNames: SUPPRESS,
      task,
    })
    return { content: res.text || '(no output)', isError: !!res.error }
  }

  private entry(agentType: string): SubagentEntry {
    const e = this.cfg.registry.get(agentType)
    if (!e) throw new Error(`agent not registered: ${agentType}`)
    return e
  }

  private projector(threadId: string): Projector {
    let p = this.projectors.get(threadId)
    if (!p) {
      p = new Projector(this.cfg.sinkFor(threadId))
      this.projectors.set(threadId, p)
    }
    return p
  }

  private resource(threadId: string): string {
    return this.cfg.resourceFor?.(threadId) ?? threadId
  }
}
