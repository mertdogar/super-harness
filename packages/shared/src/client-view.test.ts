import { describe, expect, it } from 'vitest'
import { diffTree, subscribeTree, emptyTree, sumUsage, type ClientTree, type TreeClient } from './client-view'
import type { NodeRow, ThreadRow, ToolRow } from './contract'
import type { NodeState, ToolState } from './tree'

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

  it('defers tool_start until the tool leaves input-streaming (args ready)', () => {
    const prev0: ClientTree = { turns: ['r'], nodes: { r: node({ nodeId: 'r', parentNodeId: null, depth: 0 }) } }
    const streaming: ClientTree = {
      turns: ['r'],
      nodes: {
        r: node({
          nodeId: 'r',
          parentNodeId: null,
          depth: 0,
          toolOrder: ['c1'],
          tools: { c1: tool({ toolCallId: 'c1', toolName: 'weather', status: 'input-streaming' }) },
        }),
      },
    }
    const ready: ClientTree = {
      turns: ['r'],
      nodes: {
        r: node({
          nodeId: 'r',
          parentNodeId: null,
          depth: 0,
          toolOrder: ['c1'],
          tools: { c1: tool({ toolCallId: 'c1', toolName: 'weather', status: 'input-available', args: { location: 'Berlin' } }) },
        }),
      },
    }
    // while streaming: no tool_start yet (args not ready)
    expect(diffTree(prev0, streaming).some((e) => e.type === 'tool_start')).toBe(false)
    // once available: tool_start carries the args
    const ts = diffTree(streaming, ready).find((e) => e.type === 'tool_start')
    expect(ts).toMatchObject({ toolCallId: 'c1', args: { location: 'Berlin' } })
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

describe('sumUsage', () => {
  it('sums per-node usage, recomputes total, keeps cached/reasoning as sub-sums, treats missing as 0', () => {
    const nodes: NodeState[] = [
      node({
        nodeId: 'r',
        parentNodeId: null,
        depth: 0,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, reasoningTokens: 5, totalTokens: 999 },
      }),
      node({ nodeId: 'c', parentNodeId: 'r', depth: 1, usage: { inputTokens: 50, outputTokens: 10 } }), // no cached/reasoning
      node({ nodeId: 'x', parentNodeId: 'r', depth: 1 }), // no usage at all
    ]
    expect(sumUsage(nodes)).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180, // recomputed from parts, NOT the reported 999
      cachedInputTokens: 80,
      reasoningTokens: 5,
    })
  })

  it('returns zeros for an empty set', () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 })
  })
})

function threadRow(p: Partial<ThreadRow> & { id: string }): ThreadRow {
  return { turns: [], todos: [], createdAt: 0, updatedAt: 0, ...p }
}
function nodeRow(p: Partial<NodeRow> & { id: string; threadId: string; parentNodeId: string | null; depth: number }): NodeRow {
  return { status: 'running', reasoning: '', text: '', toolOrder: [], childOrder: [], ...p }
}
function toolRow(p: Partial<ToolRow> & { id: string; threadId: string; nodeId: string; status: ToolRow['status'] }): ToolRow {
  return { toolName: 'x', argsText: '', ...p }
}

// Fake collections client: per-collection row maps + delta-event handlers, with
// push-able rows that notify rowset subscribers. Ignores the query filter (the
// test pushes only one thread's rows).
function fakeClient() {
  const rowsByColl = new Map<string, Map<string, { id: string }>>()
  const subs = new Map<string, Set<() => void>>()
  const handlers = new Map<string, Set<(d: unknown) => void>>()
  const coll = (c: string) => rowsByColl.get(c) ?? (rowsByColl.set(c, new Map()), rowsByColl.get(c)!)
  const client: TreeClient = {
    collection: (name) => ({
      subscribe: () => ({
        rows: () => [...coll(name).values()],
        subscribe: (cb: () => void) => {
          const s = subs.get(name) ?? new Set<() => void>()
          s.add(cb)
          subs.set(name, s)
          return () => s.delete(cb)
        },
        ready: Promise.resolve(),
      }),
    }),
    on: (event: string, handler: (data: never) => void) => {
      const s = handlers.get(event) ?? new Set<(d: unknown) => void>()
      s.add(handler as (d: unknown) => void)
      handlers.set(event, s)
      return () => s.delete(handler as (d: unknown) => void)
    },
  }
  const put = (c: string, row: { id: string }) => {
    coll(c).set(row.id, row)
    for (const cb of subs.get(c) ?? []) cb()
  }
  const emit = (event: string, data: unknown) => {
    for (const h of handlers.get(event) ?? []) h(data)
  }
  return { client, put, emit }
}

describe('subscribeTree', () => {
  it('assembles the tree from thread + node + tool rows, folding usage', () => {
    const { client, put } = fakeClient()
    let latest: ClientTree = emptyTree()
    const stop = subscribeTree(client, 't1', (tree) => (latest = tree))

    put('harness.threads', threadRow({ id: 't1', turns: ['r'] }))
    put(
      'harness.nodes',
      nodeRow({
        id: 'r',
        threadId: 't1',
        parentNodeId: null,
        depth: 0,
        status: 'complete',
        text: 'hi',
        usage: { inputTokens: 40, outputTokens: 8, cachedInputTokens: 32 },
      }),
    )
    put('harness.tools', toolRow({ id: 'c1', threadId: 't1', nodeId: 'r', toolName: 'search', status: 'output-available', result: 'ok' }))

    expect(latest.turns).toEqual(['r'])
    expect(latest.nodes.r?.text).toBe('hi')
    expect(latest.nodes.r?.tools.c1).toMatchObject({ toolName: 'search', status: 'output-available', result: 'ok' })
    expect(latest.usage).toEqual({ inputTokens: 40, outputTokens: 8, totalTokens: 48, cachedInputTokens: 32, reasoningTokens: 0 })
    stop()
  })

  it('overlays live token deltas on a running node, then defers to the row once terminal', () => {
    const { client, put, emit } = fakeClient()
    let latest: ClientTree = emptyTree()
    const stop = subscribeTree(client, 't1', (tree) => (latest = tree))

    put('harness.threads', threadRow({ id: 't1', turns: ['r'] }))
    put('harness.nodes', nodeRow({ id: 'r', threadId: 't1', parentNodeId: null, depth: 0, status: 'running' }))

    // Running node: text/reasoning come from the delta stream, not the (empty) row.
    emit('harness.textDelta', { threadId: 't1', nodeId: 'r', text: 'hel' })
    emit('harness.textDelta', { threadId: 't1', nodeId: 'r', text: 'lo' })
    emit('harness.reasoningDelta', { threadId: 't1', nodeId: 'r', text: 'thinking' })
    expect(latest.nodes.r?.text).toBe('hello')
    expect(latest.nodes.r?.reasoning).toBe('thinking')

    // Deltas for another thread are ignored.
    emit('harness.textDelta', { threadId: 'other', nodeId: 'r', text: 'X' })
    expect(latest.nodes.r?.text).toBe('hello')

    // Terminal: the row's final strings win over the (now-cleared) live overlay.
    put('harness.nodes', nodeRow({ id: 'r', threadId: 't1', parentNodeId: null, depth: 0, status: 'complete', text: 'hello world', reasoning: 'thought' }))
    expect(latest.nodes.r?.text).toBe('hello world')
    expect(latest.nodes.r?.reasoning).toBe('thought')
    stop()
  })

  it('keeps toolOrder coherent when a tool row lags the node row', () => {
    const { client, put } = fakeClient()
    let latest: ClientTree = emptyTree()
    const stop = subscribeTree(client, 't1', (tree) => (latest = tree))

    put('harness.threads', threadRow({ id: 't1', turns: ['r'] }))
    // Node row lists c1 in toolOrder, but its tool row (a separate collection)
    // hasn't landed yet — the two rows update independently.
    put('harness.nodes', nodeRow({ id: 'r', threadId: 't1', parentNodeId: null, depth: 0, toolOrder: ['c1'] }))

    // The assembled node must never reference a tool that isn't present: a
    // consumer reading tools[id].textOffset for every id in toolOrder would crash.
    const r = latest.nodes.r!
    expect(r.toolOrder.every((id) => r.tools[id])).toBe(true)

    // Once the tool row arrives, it reappears in order.
    put('harness.tools', toolRow({ id: 'c1', threadId: 't1', nodeId: 'r', toolName: 'search', status: 'input-available' }))
    expect(latest.nodes.r?.toolOrder).toEqual(['c1'])
    stop()
  })

  it('streams tool argsText from toolInputDelta while input-streaming', () => {
    const { client, put, emit } = fakeClient()
    let latest: ClientTree = emptyTree()
    const stop = subscribeTree(client, 't1', (tree) => (latest = tree))

    put('harness.threads', threadRow({ id: 't1', turns: ['r'] }))
    put('harness.nodes', nodeRow({ id: 'r', threadId: 't1', parentNodeId: null, depth: 0, toolOrder: ['c1'] }))
    put('harness.tools', toolRow({ id: 'c1', threadId: 't1', nodeId: 'r', toolName: 'search', status: 'input-streaming' }))

    emit('harness.toolInputDelta', { threadId: 't1', nodeId: 'r', toolCallId: 'c1', argsTextDelta: '{"q":' })
    emit('harness.toolInputDelta', { threadId: 't1', nodeId: 'r', toolCallId: 'c1', argsTextDelta: '"x"}' })
    expect(latest.nodes.r?.tools.c1?.argsText).toBe('{"q":"x"}')

    // Settled: the row's argsText wins.
    put('harness.tools', toolRow({ id: 'c1', threadId: 't1', nodeId: 'r', toolName: 'search', status: 'input-available', argsText: '{"q":"x"}', args: { q: 'x' } }))
    expect(latest.nodes.r?.tools.c1?.args).toEqual({ q: 'x' })
    stop()
  })
})
