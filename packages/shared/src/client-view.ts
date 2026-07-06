// The client read-side of the collections transport — the symmetric counterpart
// to the server's projector. `subscribeTree` assembles the reactive tree from
// the `harness.threads`/`harness.nodes`/`harness.tools` collection subscriptions
// plus the ephemeral token-delta EVENTS (reasoning/text/argsText live preview);
// `diffTree` turns two snapshots into the HarnessEvent stream a consumer wants
// incrementally (the headless printer). Any consumer — this TUI, a browser chat,
// an eval — reads a session the same way.

import { eq } from '@super-line/core'
import { HARNESS_NODES, HARNESS_THREADS, HARNESS_TOOLS } from './contract'
import type { NodeRow, ThreadRow, ToolRow } from './contract'
import type { HarnessEvent, TodoItem, TokenUsage } from './events'
import type { NodeState, NodeStatus, ToolState } from './tree'

export interface ClientTree {
  turns: string[]
  todos?: TodoItem[]
  nodes: Record<string, NodeState>
  // Derived cumulative token total over `nodes` (populated by subscribeTree).
  usage?: TokenUsage
}

export function emptyTree(): ClientTree {
  return { turns: [], nodes: {} }
}

// Cumulative token total over a set of nodes. cached/reasoning are informational
// sub-counts (⊆ input/output), so they're summed independently; totalTokens is
// recomputed from parts rather than trusting per-node reported totals. Level-
// agnostic: pass the whole tree for a conversation total, or a turn's subtree.
export function sumUsage(nodes: Iterable<NodeState>): TokenUsage {
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let reasoningTokens = 0
  for (const n of nodes) {
    const u = n.usage
    if (!u) continue
    inputTokens += u.inputTokens ?? 0
    outputTokens += u.outputTokens ?? 0
    cachedInputTokens += u.cachedInputTokens ?? 0
    reasoningTokens += u.reasoningTokens ?? 0
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens, reasoningTokens }
}

// Structural view of the super-line client surface subscribeTree drives —
// `collection(name).subscribe(query)` for the durable rows and `on(event, cb)`
// for the ephemeral token stream. Kept loose (not the client's exact generics)
// so a client built against ANY host contract that merges harnessContract() fits.
interface RowSet {
  rows(): unknown[]
  subscribe(cb: () => void): () => void
  readonly ready: Promise<void>
}
interface CollectionView {
  subscribe(query?: unknown): RowSet
}
export interface TreeClient {
  collection(name: string): CollectionView
  on(event: string, handler: (data: never) => void): () => void
}

interface DeltaEvent {
  threadId: string
  nodeId: string
  toolCallId?: string
  text?: string
  argsTextDelta?: string
}

// Subscribes the thread/node/tool rows for `threadId` plus the token-delta events,
// re-assembling the tree on every change. Model (c): while a node/tool runs, its
// reasoning/text/argsText come from the accumulated DELTA stream (the row's
// strings stay empty until it settles); once terminal, the row is authoritative.
export function subscribeTree(
  client: TreeClient,
  threadId: string,
  onChange: (tree: ClientTree) => void,
): () => void {
  const threadsSub = client.collection(HARNESS_THREADS).subscribe({ filter: eq('id', threadId) })
  const nodesSub = client.collection(HARNESS_NODES).subscribe({ filter: eq('threadId', threadId) })
  const toolsSub = client.collection(HARNESS_TOOLS).subscribe({ filter: eq('threadId', threadId) })

  // Live token accumulators, keyed by node / toolCall — cleared when the row settles.
  const liveText = new Map<string, string>()
  const liveReasoning = new Map<string, string>()
  const liveArgs = new Map<string, string>()

  const build = (): void => {
    const thread = (threadsSub.rows() as ThreadRow[])[0]
    const toolsByNode = new Map<string, ToolRow[]>()
    for (const tr of toolsSub.rows() as ToolRow[]) {
      const list = toolsByNode.get(tr.nodeId) ?? []
      list.push(tr)
      toolsByNode.set(tr.nodeId, list)
    }

    const nodes: Record<string, NodeState> = {}
    for (const row of nodesSub.rows() as NodeRow[]) {
      const terminal = row.status !== 'running'
      if (terminal) {
        liveText.delete(row.id)
        liveReasoning.delete(row.id)
      }
      const tools: Record<string, ToolState> = {}
      for (const tr of toolsByNode.get(row.id) ?? []) {
        const streaming = tr.status === 'input-streaming'
        if (!streaming) liveArgs.delete(tr.id)
        tools[tr.id] = {
          toolCallId: tr.id,
          toolName: tr.toolName,
          status: tr.status,
          argsText: streaming ? (liveArgs.get(tr.id) ?? '') : tr.argsText,
          args: tr.args,
          result: tr.result,
          isError: tr.isError,
          textOffset: tr.textOffset,
        }
      }
      nodes[row.id] = {
        nodeId: row.id,
        parentNodeId: row.parentNodeId,
        depth: row.depth,
        agentType: row.agentType,
        task: row.task,
        status: row.status,
        reasoning: terminal ? row.reasoning : (liveReasoning.get(row.id) ?? ''),
        text: terminal ? row.text : (liveText.get(row.id) ?? ''),
        toolOrder: row.toolOrder,
        tools,
        childOrder: row.childOrder,
        usage: row.usage,
        durationMs: row.durationMs,
        error: row.error,
        textOffset: row.textOffset,
        pendingResume: row.pendingResume,
      }
    }
    onChange({ turns: thread?.turns ?? [], todos: thread?.todos, nodes, usage: sumUsage(Object.values(nodes)) })
  }

  const unsubs = [
    threadsSub.subscribe(build),
    nodesSub.subscribe(build),
    toolsSub.subscribe(build),
    client.on('harness.reasoningDelta', (e: DeltaEvent) => {
      if (e.threadId !== threadId) return
      liveReasoning.set(e.nodeId, (liveReasoning.get(e.nodeId) ?? '') + (e.text ?? ''))
      build()
    }),
    client.on('harness.textDelta', (e: DeltaEvent) => {
      if (e.threadId !== threadId) return
      liveText.set(e.nodeId, (liveText.get(e.nodeId) ?? '') + (e.text ?? ''))
      build()
    }),
    client.on('harness.toolInputDelta', (e: DeltaEvent) => {
      if (e.threadId !== threadId || !e.toolCallId) return
      liveArgs.set(e.toolCallId, (liveArgs.get(e.toolCallId) ?? '') + (e.argsTextDelta ?? ''))
      build()
    }),
  ]

  // Initial snapshot arrives via `.ready`; live changes via the subscribe cbs.
  void Promise.all([threadsSub.ready, nodesSub.ready, toolsSub.ready]).then(build).catch(() => {})
  build()

  return () => {
    for (const off of unsubs) off()
  }
}

// Pure snapshot diff -> the HarnessEvent stream. Growth in text/reasoning becomes
// a *_delta of the appended suffix; a newly-settled tool -> tool_end; a node
// reaching a terminal status -> node_end. Deterministic; the headless printer and
// any incremental consumer fold these.
export function diffTree(prev: ClientTree, next: ClientTree): HarnessEvent[] {
  const events: HarnessEvent[] = []

  for (const id of treeOrder(next)) {
    const n = next.nodes[id]
    const p = prev.nodes[id]
    const env = { nodeId: n.nodeId, parentNodeId: n.parentNodeId, depth: n.depth, agentType: n.agentType }

    if (!p) events.push({ ...env, type: 'node_start', task: n.task })

    const grown = appended(p?.reasoning ?? '', n.reasoning)
    if (grown !== null) events.push({ ...env, type: 'reasoning_delta', text: grown })

    const grownText = appended(p?.text ?? '', n.text)
    if (grownText !== null) events.push({ ...env, type: 'text_delta', text: grownText })

    for (const tid of n.toolOrder) {
      const t = n.tools[tid]
      const pt = p?.tools[tid]
      // Emit tool_start when args first become available (the tool leaves
      // input-streaming) — not at first sight, when the streamed args are still
      // empty. hasArgs also covers a tool that appears already input-available.
      if (hasArgs(t.status) && !(pt && hasArgs(pt.status))) {
        events.push({ ...env, type: 'tool_start', toolCallId: tid, toolName: t.toolName, args: t.args })
      }
      if (isSettled(t.status) && !(pt && isSettled(pt.status))) {
        events.push({ ...env, type: 'tool_end', toolCallId: tid, result: t.result, isError: t.status === 'error' })
      }
    }

    if (n.error && n.error !== p?.error) events.push({ ...env, type: 'error', message: n.error })

    if (isTerminal(n.status) && !(p && isTerminal(p.status))) {
      const reason = n.status === 'error' ? 'error' : n.status === 'aborted' ? 'aborted' : 'complete'
      events.push({ ...env, type: 'node_end', reason, usage: n.usage, durationMs: n.durationMs })
    }
  }

  if (!sameTodos(prev.todos, next.todos) && next.todos) {
    const rootId = next.turns[next.turns.length - 1]
    const root = rootId ? next.nodes[rootId] : undefined
    if (root) {
      events.push({ nodeId: root.nodeId, parentNodeId: null, depth: root.depth, agentType: root.agentType, type: 'todo', items: next.todos })
    }
  }

  return events
}

// Returns the appended suffix when `next` extends `prev`; the whole of `next` on a
// non-append rewrite; null when unchanged/shrunk.
function appended(prev: string, next: string): string | null {
  if (next === prev || next.length === 0) return null
  if (next.startsWith(prev)) return next.slice(prev.length)
  return next
}

function isSettled(s: NodeState['tools'][string]['status']): boolean {
  return s === 'output-available' || s === 'error'
}

// Args are available once the tool leaves the input-streaming phase.
function hasArgs(s: NodeState['tools'][string]['status']): boolean {
  return s !== 'input-streaming'
}

function isTerminal(s: NodeStatus): boolean {
  return s === 'complete' || s === 'aborted' || s === 'error'
}

function sameTodos(a: TodoItem[] | undefined, b: TodoItem[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((t, i) => t.content === b[i].content && t.status === b[i].status)
}

// Parent-before-child, turn order — so node_start precedes a child's events.
function treeOrder(tree: ClientTree): string[] {
  const out: string[] = []
  const visit = (id: string) => {
    const n = tree.nodes[id]
    if (!n) return
    out.push(id)
    for (const c of n.childOrder) visit(c)
  }
  for (const root of tree.turns) visit(root)
  for (const id of Object.keys(tree.nodes)) if (!out.includes(id)) out.push(id)
  return out
}
