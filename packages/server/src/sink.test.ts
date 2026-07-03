// The sink's new logic vs the old co-writer: coalesce a burst of stream events
// into one write (the final doc), and merge a restart base into the thread doc.
// End-to-end fan-out is covered by wire.test.ts on the memory backend.

import { describe, expect, it, vi } from 'vitest'
import { superlineTreeSink } from './sink'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeNs() {
  const created: Array<{ id: string; data: unknown; rules: unknown }> = []
  const writes: Array<{ id: string; data: unknown }> = []
  let readData: unknown
  const ns = {
    create: async (id: string, data: unknown, rules?: unknown) => void created.push({ id, data, rules }),
    read: async (_id: string) => (readData === undefined ? undefined : { data: readData }),
    write: async (id: string, data: unknown) => void writes.push({ id, data }),
  }
  return { ns, created, writes, setRead: (d: unknown) => (readData = d) }
}

describe('superlineTreeSink', () => {
  it('creates a node once and coalesces a burst into a single final write', async () => {
    const node = fakeNs()
    const thread = fakeNs()
    const sink = superlineTreeSink({
      nodeStore: node.ns as never,
      threadStore: thread.ns as never,
      threadId: 't',
      grantTo: () => ['u1'],
      flushMs: 10,
    })

    // A tight burst — one event per streamed token — all land before flushMs.
    for (let i = 0; i < 20; i++) sink.writeNode({ nodeId: 'n1', text: 'x'.repeat(i) } as never)

    await sleep(0) // let the create microtask run (flush timer hasn't fired yet)
    // First event creates the Resource (with its read grant); no write yet.
    expect(node.created).toHaveLength(1)
    expect(node.created[0]).toMatchObject({ id: 'n1', rules: { u1: { read: true } } })
    expect(node.writes).toHaveLength(0)

    await sleep(30)
    // The whole burst coalesced to ONE trailing write carrying the final doc.
    expect(node.writes).toHaveLength(1)
    expect(node.writes[0]).toMatchObject({ id: 'n1', data: { nodeId: 'n1', text: 'x'.repeat(19) } })
  })

  it('separate bursts each flush; the final doc always lands', async () => {
    const node = fakeNs()
    const thread = fakeNs()
    const sink = superlineTreeSink({
      nodeStore: node.ns as never,
      threadStore: thread.ns as never,
      threadId: 't',
      grantTo: () => [],
      flushMs: 10,
    })

    sink.writeNode({ nodeId: 'n1', text: 'a' } as never) // create
    sink.writeNode({ nodeId: 'n1', text: 'ab' } as never) // burst 1
    await sleep(30)
    sink.writeNode({ nodeId: 'n1', text: 'abc' } as never) // burst 2
    await sleep(30)

    expect(node.created).toHaveLength(1)
    expect(node.writes.map((w) => (w.data as { text: string }).text)).toEqual(['ab', 'abc'])
  })

  it('swallows a benign CONFLICT create but logs a genuine create failure', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thread = fakeNs()
      const conflict = { ...fakeNs().ns, create: async () => Promise.reject({ code: 'CONFLICT' }) }
      const s1 = superlineTreeSink({ nodeStore: conflict as never, threadStore: thread.ns as never, threadId: 't', grantTo: () => [], flushMs: 10 })
      s1.writeNode({ nodeId: 'n1', text: 'a' } as never)
      await sleep(5)
      expect(err).not.toHaveBeenCalled() // CONFLICT is expected (restart / pre-created)

      const boom = { ...fakeNs().ns, create: async () => Promise.reject({ code: 'INTERNAL', message: 'driver down' }) }
      const s2 = superlineTreeSink({ nodeStore: boom as never, threadStore: thread.ns as never, threadId: 't', grantTo: () => [], flushMs: 10 })
      s2.writeNode({ nodeId: 'n2', text: 'a' } as never)
      await sleep(5)
      expect(err).toHaveBeenCalled() // a real failure must not be masked
    } finally {
      err.mockRestore()
    }
  })

  it('merges the persisted restart base into the thread doc (turns + nodes)', async () => {
    const node = fakeNs()
    const thread = fakeNs()
    thread.setRead({ turns: ['old'], nodes: { old: { nodeId: 'old' } } })
    const sink = superlineTreeSink({
      nodeStore: node.ns as never,
      threadStore: thread.ns as never,
      threadId: 't',
      grantTo: () => [],
      flushMs: 10,
    })

    sink.writeThread({ turns: ['new'], nodes: { new: { nodeId: 'new' } } } as never)
    await sleep(0) // let the async prepare(read)→create run

    expect(thread.created).toHaveLength(1)
    const created = thread.created[0].data as { turns: string[]; nodes: Record<string, unknown> }
    expect(created.turns).toEqual(['old', 'new'])
    expect(Object.keys(created.nodes).sort()).toEqual(['new', 'old'])
  })
})
