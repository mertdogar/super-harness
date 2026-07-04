// Composition e2e: the harness mounted INSIDE a host super-line server whose
// contract merges harnessSurface with the host's own surface — ONE socket
// carries both. Proves the library pattern end to end: mergeSurfaces into
// `shared` + harnessStores spread + mountHarness handlers spread, prefixed
// keys, and the lazy resource-room join (no onConnection hook to wire).
// Deliberately cast-free around the mount API — this test IS the host DX.

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { z } from 'zod'
import { defineContract, defineSurface, mergeSurfaces } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryStoreClient } from '@super-line/store-memory'
import { harnessSurface, subscribeTree, diffTree, emptyTree, type ClientTree, type HarnessEvent } from '@super-harness/shared'
import { Harness, type SubagentEntry, type ThreadRecord, type ThreadStore } from '@super-harness/core'
import type { AgentRunner, NodeEnvelope, HarnessRuntime } from '@super-harness/core'
import { harnessStores, mountHarness } from './serve'

const PORT = 4127
const URL = `ws://127.0.0.1:${PORT}/ws`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The host app's own contract: harnessSurface merged into `shared` (rooms only
// carry shared events) next to a host-owned request.
const hostContract = defineContract({
  shared: mergeSurfaces(
    harnessSurface,
    defineSurface({
      clientToServer: {
        'demo.echo': { input: z.object({ text: z.string() }), output: z.object({ echoed: z.string() }) },
      },
    }),
  ),
  roles: { user: {} },
})

const fakeRunner =
  () =>
  (_node: NodeEnvelope, _runtime: HarnessRuntime): AgentRunner =>
  async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: 'composed reply' } }
      yield { type: 'finish', payload: { output: { usage: { totalTokens: 3 } } } }
    })(),
  })

function buildHarness(threads?: ThreadStore): Harness {
  const registry = new Map<string, SubagentEntry>()
  registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner() })
  return new Harness({ supervisorType: 'supervisor', registry, maxDepth: 1, threads })
}

function fakeThreadStore(): ThreadStore {
  const rows = new Map<string, ThreadRecord>()
  return {
    createThread: async ({ threadId, resourceId, title }) => {
      const t = { id: threadId ?? `t${rows.size}`, resourceId, title }
      rows.set(t.id, t)
      return t
    },
    getThreadById: async ({ threadId }) => rows.get(threadId) ?? null,
    saveThread: async ({ thread }) => rows.set(thread.id, thread),
    deleteThread: async (threadId) => void rows.delete(threadId),
    listThreads: async ({ filter } = {}) => ({
      threads: [...rows.values()].filter((t) => !filter?.resourceId || t.resourceId === filter.resourceId),
    }),
  }
}

async function startHost(harness: Harness) {
  const httpServer: Server = createServer()
  const srv = createSuperLineServer(hostContract, {
    transports: [webSocketServerTransport({ server: httpServer, path: '/ws' })],
    // The HOST owns auth — its ctx just has to extend HarnessCtx, and identify
    // must return ctx.userId: store ACL grants key on it (principal falls back
    // to the random conn.id otherwise, and every tree read is denied).
    authenticate: () => ({ role: 'user' as const, ctx: { userId: 'u1', resourceId: 'res-1' } }),
    identify: (conn) => (conn.ctx as { userId: string }).userId,
    stores: { ...(await harnessStores({ type: 'memory' })) },
  })
  const mount = mountHarness(srv, harness)
  srv.implement({
    shared: {
      ...mount.handlers,
      'demo.echo': async ({ text }) => ({ echoed: text.toUpperCase() }),
    },
    user: {},
  })
  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))
  return { httpServer, mount }
}

function mkClient() {
  return createSuperLineClient(hostContract, {
    transport: webSocketClientTransport({ url: URL }),
    role: 'user',
    stores: { 'harness.node': memoryStoreClient(), 'harness.thread': memoryStoreClient() },
  })
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('composition (harness mounted in a host super-line server)', () => {
  it('drives the host surface AND a full harness turn over one socket', async () => {
    const { httpServer, mount } = await startHost(buildHarness())
    const client = mkClient()
    cleanup = () => {
      client.close()
      mount.close()
      httpServer.close()
    }

    // Host request and harness request side by side on the same connection.
    expect(await client['demo.echo']({ text: 'hi' })).toEqual({ echoed: 'HI' })
    await client['harness.join']({ threadId: 'ct1' })

    const events: HarnessEvent[] = []
    let prev: ClientTree = emptyTree()
    let done = false
    const stop = subscribeTree(client, 'ct1', (tree) => {
      for (const e of diffTree(prev, tree)) {
        events.push(e)
        if (e.type === 'node_end' && e.parentNodeId === null) done = true
      }
      prev = tree
    })

    await client['harness.sendMessage']({ threadId: 'ct1', message: 'go' })
    for (let i = 0; i < 300 && !done; i++) await sleep(10)
    stop()

    expect(done).toBe(true)
    const root = events.find((e) => e.type === 'node_start' && e.parentNodeId === null)!
    expect(prev.nodes[root.nodeId]?.status).toBe('complete')
    expect(prev.nodes[root.nodeId]?.text).toBe('composed reply')
  })

  it('lazy resource-room join: a second tab that listed threads gets threadCreated', async () => {
    const { httpServer, mount } = await startHost(buildHarness(fakeThreadStore()))
    const a = mkClient()
    const b = mkClient()
    cleanup = () => {
      a.close()
      b.close()
      mount.close()
      httpServer.close()
    }

    const created: unknown[] = []
    b.on('harness.threadCreated', (p) => void created.push(p))
    // No onConnection hook exists under composition — listing threads is what
    // puts B's connection in the resource room.
    await b['harness.listThreads']({})

    const { threadId } = await a['harness.createThread']({ title: 'Composed' })
    for (let i = 0; i < 200 && created.length === 0; i++) await sleep(10)
    expect(created[0]).toMatchObject({ id: threadId, resourceId: 'res-1' })
  })
})
