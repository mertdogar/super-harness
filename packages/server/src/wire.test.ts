// End-to-end wire test: a real super-line server + client over a real WebSocket,
// a canned turn driven through the Projector -> Store, read back via the client
// view (subscribeTree + diffTree). Exercises the full transport (client transport
// <-> server transport over ws) + Store sync + ACL, with no Mastra/model/key.
// This is the test that caught the create/open ACL race and the open-before-create
// dead-handle bug.

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryStoreServer, memoryStoreClient } from '@super-line/store-memory'
import { contract, diffTree, emptyTree, subscribeTree, type ClientTree, type HarnessEvent } from '@super-harness/shared'
import { Projector } from '@super-harness/core'
import { superlineTreeSink } from './sink'

const PORT = 4123
const URL = `ws://127.0.0.1:${PORT}/super-line`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ROOT = { nodeId: 'r1', parentNodeId: null, depth: 0, agentType: 'supervisor' } as const
const CHILD = { nodeId: 'c1', parentNodeId: 'r1', depth: 1, agentType: 'worker' } as const
const TURN: HarnessEvent[] = [
  { ...ROOT, type: 'node_start' },
  { ...ROOT, type: 'text_delta', text: 'Working on it. ' },
  { ...CHILD, type: 'node_start', task: 'fetch weather' },
  { ...CHILD, type: 'tool_start', toolCallId: 't1', toolName: 'weather', args: { city: 'NYC' } },
  { ...CHILD, type: 'tool_end', toolCallId: 't1', result: { tempF: 72 }, isError: false },
  { ...CHILD, type: 'node_end', reason: 'complete', usage: { totalTokens: 5 } },
  { ...ROOT, type: 'text_delta', text: 'Done.' },
  { ...ROOT, type: 'node_end', reason: 'complete', usage: { totalTokens: 12 } },
]

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('wire (super-line server <-> client over ws, via the Store)', () => {
  it('syncs a canned turn tree to the client through subscribeTree + diffTree', async () => {
    const principals = new Map<string, Set<string>>()
    const httpServer: Server = createServer()
    const srv = createSuperLineServer(contract, {
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
      authenticate: (h: { query?: Record<string, string> }) => ({ role: 'user' as const, ctx: { userId: h.query?.userId ?? 'local' } }),
      identify: (conn: { ctx: { userId: string } }) => conn.ctx.userId,
      stores: { node: memoryStoreServer(), thread: memoryStoreServer() },
    } as never)

    srv.implement({
      shared: {
        join: async ({ threadId }: { threadId: string }, ctx: { userId: string }, conn: unknown) => {
          srv.room(`thread:${threadId}`).add(conn as never)
          const set = principals.get(threadId) ?? new Set<string>()
          set.add(ctx.userId)
          principals.set(threadId, set)
          const store = srv.store('thread') as unknown as { create(id: string, d: unknown, r: unknown): Promise<void> }
          await store.create(threadId, { turns: [], nodes: {} }, { [ctx.userId]: { read: true } }).catch(() => {})
          return { ok: true }
        },
        sendMessage: async ({ threadId }: { threadId: string }) => {
          const sink = superlineTreeSink({
            nodeStore: srv.store('node') as never,
            threadStore: srv.store('thread') as never,
            threadId,
            grantTo: [...(principals.get(threadId) ?? [])],
          })
          const projector = new Projector(sink)
          void (async () => {
            for (const ev of TURN) {
              projector.emit(ev)
              await sleep(10)
            }
          })()
          return { ok: true }
        },
        resumeMessage: async () => ({ ok: true }),
        abort: async () => ({ ok: true }),
      },
      user: {},
    } as never)

    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url: URL }),
      role: 'user',
      params: { userId: 'local' },
      stores: { node: memoryStoreClient(), thread: memoryStoreClient() },
    } as never)

    cleanup = () => {
      client.close()
      httpServer.close()
    }

    const events: HarnessEvent[] = []
    let prev: ClientTree = emptyTree()
    let done = false

    await client.join({ threadId: 't1' })
    const stop = subscribeTree(client as never, 't1', (tree) => {
      for (const e of diffTree(prev, tree)) {
        events.push(e)
        if (e.type === 'node_end' && e.parentNodeId === null) done = true
      }
      prev = tree
    })

    await client.sendMessage({ threadId: 't1', message: 'weather?' })
    for (let i = 0; i < 300 && !done; i++) await sleep(20)
    stop()

    expect(done).toBe(true)

    // the supervisor root and the delegated worker child both synced
    const roots = events.filter((e) => e.type === 'node_start' && e.parentNodeId === null)
    const children = events.filter((e) => e.type === 'node_start' && e.parentNodeId === 'r1')
    expect(roots).toHaveLength(1)
    expect(children[0]).toMatchObject({ nodeId: 'c1', depth: 1, agentType: 'worker' })

    // the worker's tool ran and settled ok
    const toolEnd = events.find((e) => e.type === 'tool_end')
    expect(toolEnd).toMatchObject({ toolCallId: 't1', isError: false, result: { tempF: 72 } })

    // final tree state (from the Store) has both nodes complete
    expect(prev.nodes.r1?.status).toBe('complete')
    expect(prev.nodes.r1?.text).toBe('Working on it. Done.')
    expect(prev.nodes.c1?.status).toBe('complete')
    expect(prev.nodes.c1?.tools.t1?.status).toBe('output-available')
  })
})
