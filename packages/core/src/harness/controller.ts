// The pure orchestration engine. Mastra-first at the surface (createController
// takes Agents), framework-agnostic inside (the Controller drives nodes through
// RunnerFactories; the self-check passes a fake). No transport, no super-line:
// the tree leaves through the optional TreeSink, HITL through onSuspended, and
// the turn result comes back from run()/resume().
// Root-only HITL: a suspension parks the turn; resume re-enters the same root.

import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import type { ToolsInput } from '@mastra/core/agent'
import { nanoid } from 'nanoid'
import type { TokenUsage } from '@super-harness/shared'
import type { Suspension } from './chunk-adapter'
import type { TreeSink } from './sink'
import { Projector } from './projector'
import { runNode, type AgentRunner, type NodeEnvelope, type StreamResult } from './run-node'
import { DELEGATE_TOOL, HARNESS_RUNTIME_KEY, type HarnessRuntime } from './runtime'
import { makeDelegateTool, askUserTool, todoTool } from './tools'

export interface SubagentEntry {
  agentType: string
  recall?: boolean
  // Resolved adjacency list: which agentTypes this agent may delegate to.
  delegatesTo?: string[]
  maxSteps?: number
  makeRunner: (node: NodeEnvelope, runtime: HarnessRuntime) => AgentRunner
}

// Low-level, framework-free config (tests drive this directly with fake runners).
export interface EngineConfig {
  supervisorType: string
  registry: Map<string, SubagentEntry>
  maxDepth: number
  sinkFor?: (threadId: string) => TreeSink
  resourceFor?: (threadId: string) => string
  onSuspended?: (threadId: string, s: Suspension & { nodeId: string }) => void
}

export type RunResult =
  | { status: 'done'; text: string; usage?: TokenUsage }
  | { status: 'suspended'; suspension: Suspension & { nodeId: string } }
  | { status: 'error'; error: string; text: string }

const SUPPRESS = new Set([DELEGATE_TOOL])
const NOOP_SINK: TreeSink = { writeNode() {}, writeThread() {} }

export class Controller {
  private projectors = new Map<string, Projector>()
  private active = new Map<string, { runId: string; abort: AbortController }>()

  constructor(private cfg: EngineConfig) {}

  async run(threadId: string, message: string): Promise<RunResult> {
    const runId = nanoid()
    const abort = new AbortController()
    this.active.set(threadId, { runId, abort })
    const node: NodeEnvelope = { nodeId: runId, parentNodeId: null, depth: 0, agentType: this.cfg.supervisorType }
    return this.drive(threadId, node, message, abort.signal, true)
  }

  async resume(threadId: string, resumeData: unknown): Promise<RunResult> {
    const act = this.active.get(threadId)
    if (!act) throw new Error(`no active turn to resume for thread ${threadId}`)
    const node: NodeEnvelope = { nodeId: act.runId, parentNodeId: null, depth: 0, agentType: this.cfg.supervisorType }
    return this.drive(threadId, node, '', act.abort.signal, false, resumeData)
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
  ): Promise<RunResult> {
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
      const suspension = { ...res.suspended, nodeId: node.nodeId }
      this.cfg.onSuspended?.(threadId, suspension)
      return { status: 'suspended', suspension }
    }
    this.active.delete(threadId)
    if (res.error) return { status: 'error', error: res.error, text: res.text }
    return { status: 'done', text: res.text, usage: res.usage }
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
    const allowed = this.cfg.registry.get(parent.agentType ?? '')?.delegatesTo ?? []
    if (!allowed.includes(agentType))
      return { content: `'${parent.agentType}' may not delegate to '${agentType}'`, isError: true }
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
      p = new Projector(this.cfg.sinkFor?.(threadId) ?? NOOP_SINK)
      this.projectors.set(threadId, p)
    }
    return p
  }

  private resource(threadId: string): string {
    return this.cfg.resourceFor?.(threadId) ?? threadId
  }
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

export interface ControllerConfig {
  supervisor: Agent
  // Supervisor delegatesTo defaults to ALL subagents; override to restrict.
  delegatesTo?: string[] | true
  subagents?: SubagentConfig[]
  maxDepth?: number
  sinkFor?: (threadId: string) => TreeSink
  resourceFor?: (threadId: string) => string
  onSuspended?: (threadId: string, s: Suspension & { nodeId: string }) => void
}

export function createController(config: ControllerConfig): Controller {
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
        const rc = new RequestContext()
        rc.set(HARNESS_RUNTIME_KEY, runtime)
        const tools: Record<string, unknown> = { todo: todoTool }
        if (node.depth === 0) tools.ask_user = askUserTool // root-only HITL
        if (delegateTool) tools.delegate = delegateTool
        const streamOpts = {
          memory: { thread: opts.threadId, resource: opts.resource },
          toolsets: { harness: tools as ToolsInput },
          maxSteps: opts.maxSteps,
          abortSignal: opts.abortSignal,
          requestContext: rc,
        }
        const out =
          opts.resumeData !== undefined
            ? await agent.resumeStream(opts.resumeData, streamOpts)
            : await agent.stream(opts.input, streamOpts)
        return out as unknown as StreamResult
      }
  }

  const registry = new Map<string, SubagentEntry>()
  const supervisorEdges = resolveEdges(config.delegatesTo, subTypes)
  registry.set(config.supervisor.id, {
    agentType: config.supervisor.id,
    delegatesTo: supervisorEdges,
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

  return new Controller({
    supervisorType: config.supervisor.id,
    registry,
    maxDepth: config.maxDepth ?? 3,
    sinkFor: config.sinkFor,
    resourceFor: config.resourceFor,
    onSuspended: config.onSuspended,
  })
}
