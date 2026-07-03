// End-to-end wire test through the REAL binding: a fake-runner Harness served
// over a real WebSocket via serve(), read back via the client view
// (subscribeTree + diffTree). Exercises the harness bus -> Projector -> Store
// -> transport -> client fold, plus the suspended broadcast, with no
// model/key. (Historically this path caught the create/open ACL race and the
// open-before-create dead-handle bug.)

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryStoreClient } from '@super-line/store-memory'
import { contract, diffTree, emptyTree, subscribeTree, type ClientTree, type HarnessEvent } from '@super-harness/shared'
import { Harness, type SubagentEntry, type ThreadRecord, type ThreadStore } from '@super-harness/core'
import type { AgentRunner, NodeEnvelope, HarnessRuntime, ChunkLike } from '@super-harness/core'
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
    listThreads: async () => ({ threads: [...rows.values()] }),
  }
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('wire (serve() over ws, via the Store)', () => {
  it('syncs a delegated turn tree to the client through subscribeTree + diffTree', async () => {
    const httpServer: Server = createServer()
    const harness = buildHarness()
    const { close } = await serve(harness, {
      storage: { type: 'memory' },
      transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
    })
    await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))

    const client = createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url: URL }),
      role: 'user',
      params: { userId: 'local' },
      stores: { node: memoryStoreClient(), thread: memoryStoreClient() },
    } as never)

    cleanup = () => {
      client.close()
      close()
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
    const children = events.filter((e) => e.type === 'node_start' && e.parentNodeId !== null)
    expect(roots).toHaveLength(1)
    expect(children[0]).toMatchObject({ nodeId: 'c1', depth: 1, agentType: 'worker' })

    // the worker's tool ran and settled ok
    const toolEnd = events.find((e) => e.type === 'tool_end')
    expect(toolEnd).toMatchObject({ toolCallId: 't1', isError: false, result: { tempF: 72 } })

    // Final tree state, root id taken from the event stream — NOT prev.turns:
    // upstream super-line delivers the subscribe-time snapshot of the (empty)
    // pre-created thread doc AFTER live co-writer deltas on the same socket, so
    // a fast turn leaves the client's `turns` clobbered back to []. Node docs
    // are unaffected (subscribeTree retains opened node state).
    const rootId = roots[0].nodeId
    expect(prev.nodes[rootId]?.status).toBe('complete')
    expect(prev.nodes[rootId]?.text).toBe('Working on it. Done.')
    expect(prev.nodes.c1?.status).toBe('complete')
    expect(prev.nodes.c1?.tools.t1?.status).toBe('output-available')
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
              yield {
                type: 'text-delta',
                payload: { text: `resumed:${(opts.resumeData as { answer: string }).answer}` },
              }
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

    const client = createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url: URL }),
      role: 'user',
      params: { userId: 'local' },
      stores: { node: memoryStoreClient(), thread: memoryStoreClient() },
    } as never)
    cleanup = () => {
      client.close()
      close()
      httpServer.close()
    }

    const suspendedEvents: unknown[] = []
    client.on('suspended', (s: unknown) => void suspendedEvents.push(s))

    await client.join({ threadId: 't2' })
    await client.sendMessage({ threadId: 't2', message: 'go' })
    for (let i = 0; i < 200 && suspendedEvents.length === 0; i++) await sleep(10)

    expect(suspendedEvents[0]).toMatchObject({
      threadId: 't2',
      toolCallId: 'ask-1',
      toolName: 'ask_user',
      request: { question: 'ok?' },
    })

    await client.resumeMessage({ threadId: 't2', resumeData: { answer: 'yes' } })
    let text: string | undefined
    for (let i = 0; i < 200 && !text; i++) {
      await sleep(10)
      const tree = harness.getTree('t2')
      const rootId = tree?.turns[0]
      text = rootId ? tree!.nodes[rootId]?.text || undefined : undefined
    }
    expect(text).toBe('resumed:yes')
  })

  it('deleteThread purges the durable tree docs (thread + every node)', async () => {
    const harness = buildHarness(fakeThreadStore())
    const { server, close } = await serve(harness, { storage: { type: 'memory' } })
    cleanup = close

    const threadStore = server.store('thread') as unknown as {
      read(id: string): Promise<{ data?: { nodes?: Record<string, unknown> } } | undefined>
    }
    const nodeStore = server.store('node') as unknown as { read(id: string): Promise<unknown> }

    await harness.threads.create({ threadId: 'td' })
    await harness.sendMessage({ threadId: 'td', content: 'weather?' })

    // Sink writes are fire-and-forget — wait until the delegated turn landed.
    let doc: Awaited<ReturnType<typeof threadStore.read>>
    for (let i = 0; i < 200; i++) {
      doc = await threadStore.read('td')
      if (Object.keys(doc?.data?.nodes ?? {}).length >= 2) break
      await sleep(10)
    }
    const nodeIds = Object.keys(doc?.data?.nodes ?? {})
    expect(nodeIds).toContain('c1')
    expect(await nodeStore.read('c1')).toBeTruthy()

    await harness.threads.delete('td')
    for (let i = 0; i < 200 && (await threadStore.read('td')); i++) await sleep(10)

    expect(await threadStore.read('td')).toBeUndefined()
    for (const id of nodeIds) expect(await nodeStore.read(id)).toBeUndefined()
  })
})
