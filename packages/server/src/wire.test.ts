// End-to-end wire test through the REAL binding: a fake-runner Harness served
// over a real WebSocket via serve() (plugins:[harness()] + a memory collections
// backend), read back via the client view (subscribeTree over collections +
// token-delta events + diffTree). Exercises the bus -> Projector -> collections
// writer -> transport -> client fold, the suspended broadcast, thread-row
// reactivity, and the deleteThread cascade — with no model/key.

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { eq } from '@super-line/core'
import { contract, diffTree, emptyTree, subscribeTree, type ClientTree, type HarnessEvent } from '@super-harness/shared'
import { Harness, type SubagentEntry, type ThreadRecord, type ThreadStore } from '@super-harness/core'
import type { AgentRunner, NodeEnvelope, HarnessRuntime, ChunkLike, RunOptions } from '@super-harness/core'
import { serve } from './serve'

const PORT = 4123
const URL = `ws://127.0.0.1:${PORT}/super-line`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fakeRunner =
  (chunks: ChunkLike[], delegateTo?: { type: string; task: string; toolCallId: string }) =>
  (_node: NodeEnvelope, runtime: HarnessRuntime): AgentRunner =>
  async (_opts) => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: 'Working on it. ' } }
      if (delegateTo) {
        await runtime.delegate(delegateTo.type, delegateTo.task, delegateTo.toolCallId)
        yield { type: 'text-delta', payload: { text: 'Done.' } }
      }
      for (const c of chunks) yield c
      yield { type: 'finish', payload: { output: { usage: { totalTokens: 12 } } } }
    })(),
  })

function buildHarness(threads?: ThreadStore): Harness {
  const registry = new Map<string, SubagentEntry>()
  registry.set('supervisor', {
    agentType: 'supervisor',
    delegatesTo: ['worker'],
    makeRunner: fakeRunner([], { type: 'worker', task: 'fetch weather', toolCallId: 'c1' }),
  })
  registry.set('worker', {
    agentType: 'worker',
    makeRunner: fakeRunner([
      { type: 'tool-call', payload: { toolCallId: 't1', toolName: 'weather', args: { city: 'NYC' } } },
      { type: 'tool-result', payload: { toolCallId: 't1', toolName: 'weather', result: { tempF: 72 } } },
      { type: 'text-delta', payload: { text: 'report' } },
    ]),
  })
  return new Harness({ supervisorType: 'supervisor', registry, maxDepth: 3, threads })
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

// Subscribe a collection and keep a live view of its rows for assertions. Awaits
// the initial snapshot (`ready`) so live updates aren't clobbered by a late snapshot.
async function watchRows(
  client: unknown,
  name: string,
  filter?: unknown,
): Promise<{ rows: () => Record<string, unknown>[]; stop: () => void }> {
  const sub = (
    client as {
      collection(n: string): { subscribe(q?: unknown): { rows(): unknown[]; subscribe(cb: () => void): () => void; ready: Promise<void> } }
    }
  )
    .collection(name)
    .subscribe(filter ? { filter } : undefined)
  const off = sub.subscribe(() => {})
  await sub.ready
  return { rows: () => sub.rows() as Record<string, unknown>[], stop: off }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mkClient(params: Record<string, string>) {
  return createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url: URL }),
    role: 'user',
    params,
    // Swallow the DISCONNECTED rejection that fires when a client is torn down
    // mid-subscription — a teardown artifact, not a test failure.
    onError: () => {},
  } as never)
}

describe('wire (serve() over ws, via collections)', () => {
  it('syncs a delegated turn tree to the client through subscribeTree + diffTree', async () => {
    const httpServer: Server = createServer()
    const harness = buildHarness()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = mkClient({ userId: 'local' })
    cleanup = () => {
      client.close()
      close()
      httpServer.close()
    }

    const events: HarnessEvent[] = []
    let prev: ClientTree = emptyTree()
    let done = false

    await client['harness.join']({ threadId: 't1' })
    const stop = subscribeTree(client as never, 't1', (tree) => {
      for (const e of diffTree(prev, tree)) {
        events.push(e)
        if (e.type === 'node_end' && e.parentNodeId === null) done = true
      }
      prev = tree
    })

    await client['harness.sendMessage']({ threadId: 't1', message: 'weather?' })
    for (let i = 0; i < 300 && !done; i++) await sleep(20)
    stop()

    expect(done).toBe(true)

    const roots = events.filter((e) => e.type === 'node_start' && e.parentNodeId === null)
    const children = events.filter((e) => e.type === 'node_start' && e.parentNodeId !== null)
    expect(roots).toHaveLength(1)
    expect(children[0]).toMatchObject({ nodeId: 'c1', depth: 1, agentType: 'worker' })

    const toolEnd = events.find((e) => e.type === 'tool_end')
    expect(toolEnd).toMatchObject({ toolCallId: 't1', isError: false, result: { tempF: 72 } })

    const rootId = roots[0].nodeId
    expect(prev.nodes[rootId]?.status).toBe('complete')
    expect(prev.nodes[rootId]?.text).toBe('Working on it. Done.')
    expect(prev.nodes.c1?.status).toBe('complete')
    expect(prev.nodes.c1?.tools.t1?.status).toBe('output-available')
  })

  // Regression: a connection that carries a resourceId must still see the thread
  // rows of threads it JOINED. A client-minted thread (join + send, never
  // createThread) has no resourceId on its row — an eq(resourceId)-only filter
  // hides the caller's own thread, so subscribeTree never gets turns and the
  // conversation renders empty (found via the canvas example).
  it('delivers a client-minted thread row to a resourceId-carrying connection', async () => {
    const httpServer: Server = createServer()
    const harness = buildHarness()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = mkClient({ userId: 'canvas', resourceId: 'canvas' })
    cleanup = () => {
      client.close()
      close()
      httpServer.close()
    }

    let turns: string[] = []
    await client['harness.join']({ threadId: 't-minted' })
    const stop = subscribeTree(client as never, 't-minted', (tree) => {
      turns = tree.turns
    })

    await client['harness.sendMessage']({ threadId: 't-minted', message: 'hello' })
    for (let i = 0; i < 300 && turns.length === 0; i++) await sleep(20)
    stop()

    expect(turns).toHaveLength(1)
  })

  it('broadcasts suspended over the wire and resumes via resumeMessage', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner:
        () =>
        async (opts) => ({
          fullStream: (async function* () {
            if (opts.resumeData !== undefined) {
              yield { type: 'text-delta', payload: { text: `resumed:${(opts.resumeData as { answer: string }).answer}` } }
              return
            }
            yield {
              type: 'tool-call-suspended',
              payload: { toolCallId: 'ask-1', toolName: 'ask_user', suspendPayload: { question: 'ok?' }, args: {} },
            }
          })(),
        }),
    })
    const harness = new Harness({ supervisorType: 'supervisor', registry, maxDepth: 1 })

    const httpServer: Server = createServer()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = mkClient({ userId: 'local' })
    cleanup = () => {
      client.close()
      close()
      httpServer.close()
    }

    const suspendedEvents: unknown[] = []
    client.on('harness.suspended', (s: unknown) => void suspendedEvents.push(s))

    await client['harness.join']({ threadId: 't2' })
    await client['harness.sendMessage']({ threadId: 't2', message: 'go' })
    for (let i = 0; i < 200 && suspendedEvents.length === 0; i++) await sleep(10)

    expect(suspendedEvents[0]).toMatchObject({ threadId: 't2', toolCallId: 'ask-1', toolName: 'ask_user', request: { question: 'ok?' } })

    await client['harness.resumeMessage']({ threadId: 't2', resumeData: { answer: 'yes' } })
    let text: string | undefined
    for (let i = 0; i < 200 && !text; i++) {
      await sleep(10)
      const tree = harness.getTree('t2')
      const rootId = tree?.turns[0]
      text = rootId ? tree!.nodes[rootId]?.text || undefined : undefined
    }
    expect(text).toBe('resumed:yes')
  })

  it('reflects a generated title as a harness.threads row update', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = new Harness({
      supervisorType: 'supervisor',
      registry,
      maxDepth: 1,
      threads: fakeThreadStore(),
      generateTitle: async (input) => `Title: ${input}`,
    })

    const httpServer: Server = createServer()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = mkClient({ resourceId: 'res-1' })
    cleanup = () => {
      client.close()
      close()
      httpServer.close()
    }

    await harness.threads.create({ threadId: 't3', resourceId: 'res-1' })
    await client['harness.join']({ threadId: 't3' })
    const threads = await watchRows(client, 'harness.threads', eq('resourceId', 'res-1'))

    await client['harness.sendMessage']({ threadId: 't3', message: 'plan my trip' })
    let titled: Record<string, unknown> | undefined
    for (let i = 0; i < 200 && !titled; i++) {
      await sleep(10)
      titled = threads.rows().find((r) => r.title === 'Title: plan my trip')
    }
    threads.stop()
    expect(titled).toMatchObject({ id: 't3', title: 'Title: plan my trip' })
  })

  it('reflects create/delete as harness.threads row deltas to a second connection, and scopes listThreads', async () => {
    const harness = buildHarness(fakeThreadStore())
    const httpServer: Server = createServer()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const a = mkClient({ resourceId: 'res-1' })
    const b = mkClient({ resourceId: 'res-1' })
    cleanup = () => {
      a.close()
      b.close()
      close()
      httpServer.close()
    }

    // B watches its resource's thread list — reactivity rides collection rows.
    const bThreads = await watchRows(b, 'harness.threads', eq('resourceId', 'res-1'))

    const { threadId } = await a['harness.createThread']({ title: 'Trip' })
    let created: Record<string, unknown> | undefined
    for (let i = 0; i < 200 && !created; i++) {
      await sleep(10)
      created = bThreads.rows().find((r) => r.id === threadId)
    }
    expect(created).toMatchObject({ id: threadId, resourceId: 'res-1', title: 'Trip' })

    // A thread under a different resource must not leak into A's scoped list.
    await harness.threads.create({ threadId: 'foreign', resourceId: 'res-2' })
    const { threads } = await a['harness.listThreads']({})
    expect(threads.map((t: { id: string }) => t.id)).toContain(threadId)
    expect(threads.map((t: { id: string }) => t.id)).not.toContain('foreign')

    await a['harness.deleteThread']({ threadId })
    let gone = false
    for (let i = 0; i < 200 && !gone; i++) {
      await sleep(10)
      gone = !bThreads.rows().some((r) => r.id === threadId)
    }
    bThreads.stop()
    expect(gone).toBe(true)
  })

  it('carries sendMessage file attachments through the plugin into the engine run', async () => {
    const seen: RunOptions[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async (opts) => {
        seen.push(opts)
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } } })() }
      },
    })
    const harness = new Harness({ supervisorType: 'supervisor', registry, maxDepth: 1 })
    const httpServer: Server = createServer()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = mkClient({ userId: 'local' })
    cleanup = () => {
      client.close()
      close()
      httpServer.close()
    }

    await client['harness.join']({ threadId: 'tf' })
    const png = { url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
    await client['harness.sendMessage']({ threadId: 'tf', message: 'what is this?', files: [png] })
    // The handler fires the run without awaiting it — poll for the runner call.
    for (let i = 0; i < 200 && seen.length === 0; i++) await sleep(10)
    expect(seen[0]?.files).toEqual([png])
    expect(seen[0]?.input).toBe('what is this?')
  })

  // Resource scoping: a connection-pinned resourceId is authoritative (the
  // host's authenticate validated it — a request must not read or write another
  // tenant's scope); an UNPINNED connection opts into request-level scoping,
  // so clients can switch resources per call without reconnecting.
  it('scopes listThreads/createThread by connection resourceId, falling back to the request', async () => {
    const harness = buildHarness(fakeThreadStore())
    const httpServer: Server = createServer()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const pinned = mkClient({ userId: 'u1', resourceId: 'scene-1' })
    const roaming = mkClient({ userId: 'u2' })
    cleanup = () => {
      pinned.close()
      roaming.close()
      close()
      httpServer.close()
    }

    // A pinned connection cannot escape its scope: the request resourceId is ignored.
    const { threadId: escaped } = await pinned['harness.createThread']({ resourceId: 'scene-2', title: 'Escape?' })
    const pinnedList = await pinned['harness.listThreads']({ resourceId: 'scene-2' })
    expect(pinnedList.threads.map((t: { id: string }) => t.id)).toEqual([escaped]) // landed in scene-1, listed via scene-1

    // An unpinned connection scopes per request.
    const { threadId: r2 } = await roaming['harness.createThread']({ resourceId: 'scene-2', title: 'Other scene' })
    const scoped = await roaming['harness.listThreads']({ resourceId: 'scene-2' })
    expect(scoped.threads.map((t: { id: string }) => t.id)).toEqual([r2])
    const other = await roaming['harness.listThreads']({ resourceId: 'scene-1' })
    expect(other.threads.map((t: { id: string }) => t.id)).toEqual([escaped])
  })

  it('deleteThread purges the durable collection rows (thread + every node)', async () => {
    const harness = buildHarness(fakeThreadStore())
    const { server, close } = await serve(harness, { storage: { type: 'memory' } })
    cleanup = close

    const srv = server as unknown as {
      collection(n: string): { snapshot(q?: unknown): Promise<{ id: string }[]>; read(id: string): Promise<unknown> }
    }
    const nodes = srv.collection('harness.nodes')
    const threads = srv.collection('harness.threads')

    await harness.threads.create({ threadId: 'td' })
    await harness.sendMessage({ threadId: 'td', content: 'weather?' })

    // Writes are fire-and-forget — wait until the delegated turn's nodes landed.
    let nodeIds: string[] = []
    for (let i = 0; i < 200; i++) {
      nodeIds = (await nodes.snapshot({ filter: eq('threadId', 'td') })).map((r) => r.id)
      if (nodeIds.includes('c1')) break
      await sleep(10)
    }
    expect(nodeIds).toContain('c1')

    await harness.threads.delete('td')
    for (let i = 0; i < 200 && (await threads.read('td')); i++) await sleep(10)

    expect(await threads.read('td')).toBeUndefined()
    for (const id of nodeIds) expect(await nodes.read(id)).toBeUndefined()
  })
})
