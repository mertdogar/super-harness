// The client read-side of the Store transport — the symmetric counterpart to the
// server's projector. `subscribeTree` assembles the reactive tree from the
// `thread` + `node` Store Resources; `diffTree` turns two snapshots into the
// HarnessEvent stream a consumer wants incrementally (the headless printer). Any
// consumer — this TUI, a browser chat, an eval — reads a session the same way.

import type { HarnessEvent, TodoItem } from './events'
import type { NodeState, NodeStatus, ThreadDoc } from './tree'

export interface ClientTree {
  turns: string[]
  todos?: TodoItem[]
  nodes: Record<string, NodeState>
}

export function emptyTree(): ClientTree {
  return { turns: [], nodes: {} }
}

// Structural view of a super-line client store handle — avoids coupling to the
// client package's exact generics across core versions. getSnapshot is `unknown`
// (as the real client is); callers assert the doc shape.
interface Handle {
  getSnapshot(): unknown
  subscribe(cb: () => void): () => void
  close(): void
}
interface StoreNs {
  open(id: string): Handle
}
export interface StoreClient {
  store(name: string): StoreNs
}

// Opens the thread skeleton, then every node Resource it references (and any that
// appear later), and calls `onChange` with the assembled tree on each update.
export function subscribeTree(
  client: StoreClient,
  threadId: string,
  onChange: (tree: ClientTree) => void,
): () => void {
  const nodeStore = client.store('node')
  const threadStore = client.store('thread')
  const nodeHandles = new Map<string, Handle>()
  const nodes: Record<string, NodeState> = {}
  let thread: ThreadDoc | undefined

  const notify = () => onChange({ turns: thread?.turns ?? [], todos: thread?.todos, nodes: { ...nodes } })

  const openNode = (id: string) => {
    if (nodeHandles.has(id)) return
    const h = nodeStore.open(id)
    nodeHandles.set(id, h)
    const pull = () => {
      const s = h.getSnapshot() as NodeState | undefined
      if (s) nodes[id] = s
    }
    h.subscribe(() => {
      pull()
      notify()
    })
    pull()
  }

  const threadH = threadStore.open(threadId)
  const pullThread = () => {
    thread = threadH.getSnapshot() as ThreadDoc | undefined
    if (thread) for (const id of Object.keys(thread.nodes)) openNode(id)
  }
  threadH.subscribe(() => {
    pullThread()
    notify()
  })
  pullThread()
  notify()

  return () => {
    threadH.close()
    for (const h of nodeHandles.values()) h.close()
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
      if (!pt) events.push({ ...env, type: 'tool_start', toolCallId: tid, toolName: t.toolName, args: t.args })
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
