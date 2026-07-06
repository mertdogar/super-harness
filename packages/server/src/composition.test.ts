// Composition e2e: the harness as a PLUGIN inside a host super-line server whose
// contract merges harnessContract() with the host's own surface — ONE socket
// carries both, ONE collections backend serves both. Proves the library pattern:
// defineContract({ plugins: [harnessContract()] }) + plugins:[harness(engine)],
// harness.* subtracted from implement(), and identify → the collection principal.
// Deliberately cast-free around the plugin API — this test IS the host DX.

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { z } from 'zod'
import { defineContract, defineSurface, eq } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { harnessContract, subscribeTree, diffTree, emptyTree, type ClientTree, type HarnessEvent } from '@super-harness/shared'
import { Harness, type SubagentEntry, type ThreadRecord, type ThreadStore } from '@super-harness/core'
import type { AgentRunner, NodeEnvelope, HarnessRuntime } from '@super-harness/core'
import { harness } from './plugin'

const PORT = 4127
const URL = `ws://127.0.0.1:${PORT}/ws`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The host's own contract: harnessContract() merged via `plugins`, plus a
// host-owned request in the `user` role.
const hostContract = defineContract({
  plugins: [harnessContract()],
  roles: {
    user: defineSurface({
      clientToServer: {
        'demo.echo': { input: z.object({ text: z.string() }), output: z.object({ echoed: z.string() }) },
      },
    }),
  },
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

async function startHost(engine: Harness) {
  const httpServer: Server = createServer()
  const srv = createSuperLineServer(hostContract, {
    transports: [webSocketServerTransport({ server: httpServer, path: '/ws' })],
    // The HOST owns auth — its ctx just carries userId (the collection principal)
    // + resourceId; identify returns userId. With @super-line/plugin-auth these
    // come from the session instead.
    authenticate: () => ({ role: 'user' as const, ctx: { userId: 'u1', resourceId: 'res-1' } }),
    identify: (conn) => (conn.ctx as { userId: string }).userId,
    collections: memoryCollections(),
    plugins: [harness(engine)],
  })
  // harness.* is owned by the plugin (subtracted) — the host only implements its own.
  srv.implement({ user: { 'demo.echo': async ({ text }) => ({ echoed: text.toUpperCase() }) } })
  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))
  return { httpServer, srv }
}

function mkClient() {
  return createSuperLineClient(hostContract, {
    transport: webSocketClientTransport({ url: URL }),
    role: 'user',
    params: { userId: 'u1', resourceId: 'res-1' },
  } as never)
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('composition (harness plugin in a host super-line server)', () => {
  it('drives the host surface AND a full harness turn over one socket + one backend', async () => {
    const { httpServer, srv } = await startHost(buildHarness())
    const client = mkClient()
    cleanup = () => {
      client.close()
      void srv.close()
      httpServer.close()
    }

    // Host request and harness request side by side on the same connection.
    expect(await client['demo.echo']({ text: 'hi' })).toEqual({ echoed: 'HI' })
    await client['harness.join']({ threadId: 'ct1' })

    const events: HarnessEvent[] = []
    let prev: ClientTree = emptyTree()
    let done = false
    const stop = subscribeTree(client as never, 'ct1', (tree) => {
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

  it('reflects a created thread as a harness.threads row to a second connection', async () => {
    const { httpServer, srv } = await startHost(buildHarness(fakeThreadStore()))
    const a = mkClient()
    const b = mkClient()
    cleanup = () => {
      a.close()
      b.close()
      void srv.close()
      httpServer.close()
    }

    const bThreads = (b as unknown as {
      collection(n: string): { subscribe(q?: unknown): { rows(): { id: string }[]; subscribe(cb: () => void): () => void; ready: Promise<void> } }
    }).collection('harness.threads').subscribe({ filter: eq('resourceId', 'res-1') })
    bThreads.subscribe(() => {})
    await bThreads.ready

    const { threadId } = await a['harness.createThread']({ title: 'Composed' })
    let seen = false
    for (let i = 0; i < 200 && !seen; i++) {
      await sleep(10)
      seen = bThreads.rows().some((r) => r.id === threadId)
    }
    expect(seen).toBe(true)
  })
})
