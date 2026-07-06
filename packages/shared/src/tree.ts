// Pure fold: HarnessEvent[] -> renderable node tree. Ported from @omma's
// reducer.ts, minus `seq`/dedup (per-node Store writes are ordered) and
// generalised from one rootId to `turns[]` so a conversation accumulates many
// turn-roots in one tree. NodeState IS the per-node Store Resource doc.

import type { HarnessEvent, TodoItem, TokenUsage } from './events'

export type ToolStatus = 'input-streaming' | 'input-available' | 'output-available' | 'error'

export interface ToolState {
  toolCallId: string
  toolName: string
  status: ToolStatus
  argsText: string
  args?: unknown
  result?: unknown
  isError?: boolean
  textOffset?: number
}

export type NodeStatus = 'running' | 'complete' | 'aborted' | 'error'

export interface NodeState {
  nodeId: string
  parentNodeId: string | null
  depth: number
  agentType?: string
  task?: string
  status: NodeStatus
  reasoning: string
  text: string
  toolOrder: string[]
  tools: Record<string, ToolState>
  childOrder: string[]
  textOffset?: number
  usage?: TokenUsage
  durationMs?: number
  error?: string
  // Set from the node row when a suspension is parked (server persists it on
  // suspend, clears it on resume) — makes an ask_user prompt reconstructable
  // after a mid-turn reload. Populated by subscribeTree, not by the fold.
  pendingResume?: { resumeSchema?: string; request?: unknown }
}

export interface HarnessTree {
  turns: string[]
  nodes: Record<string, NodeState>
}

// The `thread` Store Resource doc: conversation skeleton (structure only —
// content lives on per-node Resources). Isomorphic: the server writes it, the
// client reads it to know which node Resources to open.
export interface ThreadDoc {
  turns: string[]
  todos?: TodoItem[]
  nodes: Record<string, { parentNodeId: string | null; depth: number; agentType?: string; childOrder: string[] }>
}

export function initialTree(): HarnessTree {
  return { turns: [], nodes: {} }
}

// Applies one event, returning the touched node ids (so the projector knows
// which per-node Resources to write). Mutates `tree` in place — the projector
// owns a single long-lived tree per conversation.
export function apply(tree: HarnessTree, event: HarnessEvent): string[] {
  const touched = new Set<string>()
  const id = ensureNode(tree, event, touched)

  switch (event.type) {
    case 'node_start':
      patch(tree, id, { status: 'running', agentType: event.agentType, task: event.task })
      break
    case 'node_end':
      patch(tree, id, {
        status: event.reason === 'complete' ? 'complete' : event.reason,
        usage: event.usage,
        durationMs: event.durationMs,
      })
      break
    case 'usage':
      patch(tree, id, { usage: event.usage })
      break
    case 'reasoning_delta':
      patch(tree, id, { reasoning: tree.nodes[id].reasoning + event.text })
      break
    case 'text_delta':
      patch(tree, id, { text: tree.nodes[id].text + event.text })
      break
    case 'tool_input_start':
      tool(tree, id, event.toolCallId, (t) => ({ ...t, toolName: event.toolName, status: 'input-streaming' }))
      break
    case 'tool_input_delta':
      tool(tree, id, event.toolCallId, (t) => ({ ...t, argsText: t.argsText + event.argsTextDelta }))
      break
    case 'tool_start':
      // When the model streams tool input, the tool-call chunk carries no parsed
      // `args` — they arrive as text deltas in `argsText`. Fall back to parsing it.
      tool(tree, id, event.toolCallId, (t) => ({
        ...t,
        toolName: event.toolName,
        args: event.args ?? parseArgs(t.argsText),
        status: 'input-available',
      }))
      break
    case 'tool_end':
      tool(tree, id, event.toolCallId, (t) => ({
        ...t,
        result: event.result,
        isError: event.isError,
        status: event.isError ? 'error' : 'output-available',
      }))
      break
    case 'error':
      patch(tree, id, { status: 'error', error: event.message })
      break
    case 'todo':
      break // ambient; carried on the thread doc by the projector, not a node
  }

  touched.add(id)
  return [...touched]
}

function ensureNode(tree: HarnessTree, env: HarnessEvent, touched: Set<string>): string {
  if (tree.nodes[env.nodeId]) return env.nodeId

  tree.nodes[env.nodeId] = {
    nodeId: env.nodeId,
    parentNodeId: env.parentNodeId,
    depth: env.depth,
    agentType: env.agentType,
    status: 'running',
    reasoning: '',
    text: '',
    toolOrder: [],
    tools: {},
    childOrder: [],
    textOffset: env.parentNodeId !== null ? (tree.nodes[env.parentNodeId]?.text.length ?? 0) : undefined,
  }

  if (env.parentNodeId === null) {
    if (!tree.turns.includes(env.nodeId)) tree.turns.push(env.nodeId)
  } else {
    const parent = tree.nodes[env.parentNodeId]
    if (parent && !parent.childOrder.includes(env.nodeId)) {
      parent.childOrder.push(env.nodeId)
      touched.add(env.parentNodeId)
    }
  }
  return env.nodeId
}

function patch(tree: HarnessTree, nodeId: string, p: Partial<NodeState>): void {
  const node = tree.nodes[nodeId]
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v
  }
}

function parseArgs(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function tool(tree: HarnessTree, nodeId: string, toolCallId: string, fn: (t: ToolState) => ToolState): void {
  const node = tree.nodes[nodeId]
  const base: ToolState = node.tools[toolCallId] ?? {
    toolCallId,
    toolName: '',
    status: 'input-streaming',
    argsText: '',
    textOffset: node.text.length,
  }
  node.tools[toolCallId] = fn(base)
  if (!node.toolOrder.includes(toolCallId)) node.toolOrder.push(toolCallId)
}
