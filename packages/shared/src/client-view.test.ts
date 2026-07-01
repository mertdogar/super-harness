import { describe, expect, it } from 'vitest'
import { diffTree, subscribeTree, emptyTree, type ClientTree, type StoreClient } from './client-view'
import type { NodeState, ThreadDoc, ToolState } from './tree'

function node(partial: Partial<NodeState> & { nodeId: string; parentNodeId: string | null; depth: number }): NodeState {
  return {
    status: 'running',
    reasoning: '',
    text: '',
    toolOrder: [],
    tools: {},
    childOrder: [],
    ...partial,
  }
}

function tool(partial: Partial<ToolState> & { toolCallId: string; status: ToolState['status'] }): ToolState {
  return { toolName: 'x', argsText: '', ...partial }
}

describe('diffTree', () => {
  it('emits node_start + text_delta for a new node, then settle events', () => {
    const t1: ClientTree = { turns: ['r'], nodes: { r: node({ nodeId: 'r', parentNodeId: null, depth: 0, text: 'hello' }) } }
    const e1 = diffTree(emptyTree(), t1)
    expect(e1.map((e) => e.type)).toEqual(['node_start', 'text_delta'])
    expect(e1[1]).toMatchObject({ type: 'text_delta', text: 'hello' })

    const t2: ClientTree = {
      turns: ['r'],
      nodes: {
        r: node({
          nodeId: 'r',
          parentNodeId: null,
          depth: 0,
          text: 'hello world',
          toolOrder: ['c1'],
          tools: { c1: tool({ toolCallId: 'c1', toolName: 'search', status: 'input-available', args: { q: 'x' } }) },
        }),
      },
    }
    const e2 = diffTree(t1, t2)
    expect(e2.map((e) => e.type)).toEqual(['text_delta', 'tool_start'])
    expect(e2[0]).toMatchObject({ text: ' world' }) // only the appended suffix

    const t3: ClientTree = {
      turns: ['r'],
      nodes: {
        r: node({
          nodeId: 'r',
          parentNodeId: null,
          depth: 0,
          status: 'complete',
          text: 'hello world',
          toolOrder: ['c1'],
          tools: { c1: tool({ toolCallId: 'c1', toolName: 'search', status: 'output-available', result: 'ok' }) },
          usage: { totalTokens: 12 },
        }),
      },
    }
    const e3 = diffTree(t2, t3)
    expect(e3.map((e) => e.type)).toEqual(['tool_end', 'node_end'])
    expect(e3[0]).toMatchObject({ type: 'tool_end', toolCallId: 'c1', isError: false })
    expect(e3[1]).toMatchObject({ type: 'node_end', reason: 'complete', usage: { totalTokens: 12 } })
  })

  it('emits a child node_start after its parent', () => {
    const parent = node({ nodeId: 'r', parentNodeId: null, depth: 0, childOrder: ['c'] })
    const child = node({ nodeId: 'c', parentNodeId: 'r', depth: 1, agentType: 'worker', task: 'do it' })
    const prev: ClientTree = { turns: ['r'], nodes: { r: node({ nodeId: 'r', parentNodeId: null, depth: 0 }) } }
    const next: ClientTree = { turns: ['r'], nodes: { r: parent, c: child } }
    const e = diffTree(prev, next)
    const start = e.find((x) => x.type === 'node_start' && x.nodeId === 'c')
    expect(start).toMatchObject({ parentNodeId: 'r', depth: 1, agentType: 'worker', task: 'do it' })
  })
})

describe('subscribeTree', () => {
  it('assembles the tree from thread + node Store Resources', () => {
    // Minimal fake store: named resources with push-able snapshots + subscribers.
    const resources = new Map<string, { snap: unknown; subs: Set<() => void> }>()
    const res = (key: string) => {
      let r = resources.get(key)
      if (!r) resources.set(key, (r = { snap: undefined, subs: new Set() }))
      return r
    }
    const push = (ns: string, id: string, snap: unknown) => {
      const r = res(`${ns}:${id}`)
      r.snap = snap
      for (const cb of r.subs) cb()
    }
    const client: StoreClient = {
      store: (ns) => ({
        open: <T,>(id: string) => {
          const r = res(`${ns}:${id}`)
          return {
            getSnapshot: () => r.snap as T | undefined,
            subscribe: (cb: () => void) => {
              r.subs.add(cb)
              return () => r.subs.delete(cb)
            },
            close: () => {},
          }
        },
      }),
    }

    let latest: ClientTree = emptyTree()
    const stop = subscribeTree(client, 't1', (tree) => (latest = tree))

    const thread: ThreadDoc = { turns: ['r'], nodes: { r: { parentNodeId: null, depth: 0, childOrder: [] } } }
    push('thread', 't1', thread)
    push('node', 'r', node({ nodeId: 'r', parentNodeId: null, depth: 0, text: 'hi' }))

    expect(latest.turns).toEqual(['r'])
    expect(latest.nodes.r?.text).toBe('hi')
    stop()
  })
})
