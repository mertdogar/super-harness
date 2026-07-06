// The collections writer: structural rows persist, running-string deltas dedup
// to no-ops (model c), tool rows split out, thread metadata + turns co-merge,
// pendingResume parks/clears, and a CONFLICT insert falls through to update.
// End-to-end fan-out is covered by wire.test.ts on the memory backend.

import { describe, expect, it } from 'vitest'
import type { NodeState } from '@super-harness/shared'
import { collectionsTreeSink } from './sink'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeCol() {
  const inserts: Array<{ id: string }> = []
  const updates: Array<{ id: string }> = []
  const deletes: string[] = []
  const rows = new Map<string, { id: string }>()
  const handle = {
    insert: async (row: unknown) => {
      const r = row as { id: string }
      if (rows.has(r.id)) throw Object.assign(new Error('conflict'), { code: 'CONFLICT' })
      rows.set(r.id, r)
      inserts.push(r)
    },
    update: async (row: unknown) => {
      const r = row as { id: string }
      rows.set(r.id, r)
      updates.push(r)
    },
    delete: async (id: string) => {
      rows.delete(id)
      deletes.push(id)
    },
    read: async (id: string) => rows.get(id),
    snapshot: async () => [...rows.values()],
  }
  return { handle, inserts, updates, deletes, rows }
}

function harnessNodes(overrides: Partial<NodeState> & { nodeId: string }): NodeState {
  return {
    parentNodeId: null,
    depth: 0,
    status: 'running',
    reasoning: '',
    text: '',
    toolOrder: [],
    tools: {},
    childOrder: [],
    ...overrides,
  }
}

function makeSink() {
  const nodes = fakeCol()
  const tools = fakeCol()
  const threads = fakeCol()
  const map: Record<string, ReturnType<typeof fakeCol>['handle']> = {
    'harness.nodes': nodes.handle,
    'harness.tools': tools.handle,
    'harness.threads': threads.handle,
  }
  const sink = collectionsTreeSink({
    collections: (n) => map[n],
    threadId: 't1',
    nodes: 'harness.nodes',
    tools: 'harness.tools',
    threads: 'harness.threads',
  })
  return { sink, nodes, tools, threads }
}

describe('collectionsTreeSink', () => {
  it('inserts a node once; a burst of running-string deltas dedups to no writes', async () => {
    const { sink, nodes } = makeSink()
    for (let i = 0; i < 20; i++) sink.writeNode(harnessNodes({ nodeId: 'n1', text: 'x'.repeat(i) }))
    await sleep(5)
    // One insert (structural); the growing text is NOT persisted while running,
    // so every later writeNode dedups against the same empty-string projection.
    expect(nodes.inserts).toHaveLength(1)
    expect(nodes.updates).toHaveLength(0)
    expect(nodes.rows.get('n1')).toMatchObject({ id: 'n1', status: 'running', text: '', reasoning: '' })
  })

  it('persists the final strings once the node goes terminal', async () => {
    const { sink, nodes } = makeSink()
    sink.writeNode(harnessNodes({ nodeId: 'n1', text: 'hi', reasoning: 'why' }))
    await sleep(5)
    sink.writeNode(harnessNodes({ nodeId: 'n1', status: 'complete', text: 'hi there', reasoning: 'because', usage: { totalTokens: 9 } }))
    await sleep(5)
    expect(nodes.updates.at(-1)).toMatchObject({ id: 'n1', status: 'complete', text: 'hi there', reasoning: 'because', usage: { totalTokens: 9 } })
  })

  it('writes tool rows in their own collection; argsText is empty while streaming, final when settled', async () => {
    const { sink, tools } = makeSink()
    sink.writeNode(
      harnessNodes({
        nodeId: 'n1',
        toolOrder: ['c1'],
        tools: { c1: { toolCallId: 'c1', toolName: 'search', status: 'input-streaming', argsText: '{"q":' } },
      }),
    )
    await sleep(5)
    expect(tools.rows.get('c1')).toMatchObject({ id: 'c1', nodeId: 'n1', threadId: 't1', status: 'input-streaming', argsText: '' })
    sink.writeNode(
      harnessNodes({
        nodeId: 'n1',
        toolOrder: ['c1'],
        tools: { c1: { toolCallId: 'c1', toolName: 'search', status: 'output-available', argsText: '{"q":"x"}', args: { q: 'x' }, result: 'ok' } },
      }),
    )
    await sleep(5)
    expect(tools.rows.get('c1')).toMatchObject({ status: 'output-available', argsText: '{"q":"x"}', result: 'ok' })
  })

  it('co-merges writeThread turns/todos with setThreadMeta metadata on one row', async () => {
    const { sink, threads } = makeSink()
    sink.setThreadMeta({ resourceId: 'res-1', title: 'Trip', createdAt: 5 })
    await sleep(5)
    sink.writeThread({ turns: ['r'], nodes: {} } as never)
    await sleep(5)
    const row = threads.rows.get('t1') as unknown as { turns: string[]; title?: string; resourceId?: string }
    expect(row).toMatchObject({ id: 't1', title: 'Trip', resourceId: 'res-1', turns: ['r'] })
  })

  it('parks pendingResume on the node, then clears it once the tool settles', async () => {
    const { sink, nodes } = makeSink()
    sink.setPending('n1', 'ask-1', { resumeSchema: '{"type":"string"}', request: { q: 'ok?' } })
    sink.writeNode(
      harnessNodes({
        nodeId: 'n1',
        toolOrder: ['ask-1'],
        tools: { 'ask-1': { toolCallId: 'ask-1', toolName: 'ask_user', status: 'input-available', argsText: '' } },
      }),
    )
    await sleep(5)
    expect(nodes.rows.get('n1')).toMatchObject({ pendingResume: { resumeSchema: '{"type":"string"}', request: { q: 'ok?' } } })

    sink.writeNode(
      harnessNodes({
        nodeId: 'n1',
        status: 'complete',
        toolOrder: ['ask-1'],
        tools: { 'ask-1': { toolCallId: 'ask-1', toolName: 'ask_user', status: 'output-available', argsText: '', result: 'yes' } },
      }),
    )
    await sleep(5)
    expect((nodes.rows.get('n1') as Record<string, unknown> | undefined)?.pendingResume).toBeUndefined()
  })

  it('falls through a CONFLICT insert to an update (restart safety)', async () => {
    const { sink, nodes } = makeSink()
    nodes.rows.set('n1', { id: 'n1' }) // pre-existing row (server restart)
    sink.writeNode(harnessNodes({ nodeId: 'n1', status: 'complete', text: 'recovered' }))
    await sleep(5)
    expect(nodes.updates.at(-1)).toMatchObject({ id: 'n1', text: 'recovered' })
  })
})
