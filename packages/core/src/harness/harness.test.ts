import { describe, expect, it } from 'vitest'
import { createChunkAdapter } from './chunk-adapter'
import { Projector } from './projector'
import { memoryTreeSink } from './sink'
import { Harness, type EngineConfig, type SubagentEntry, type ThreadRecord, type ThreadStore } from './harness'
import type { ChunkLike } from './chunk-adapter'
import type { HarnessEvent } from '@super-harness/shared'
import type { HarnessBusEvent } from './harness'
import type { HarnessRuntime } from './runtime'
import type { AgentRunner, NodeEnvelope, RunOptions } from './run-node'

describe('chunk-adapter', () => {
  it('maps chunks to events and suppresses delegate tool chunks', () => {
    const a = createChunkAdapter(new Set(['delegate']))
    expect(a.map({ type: 'text-delta', payload: { text: 'hi' } })).toEqual([{ type: 'text_delta', text: 'hi' }])
    expect(a.map({ type: 'reasoning-delta', payload: { text: 'hmm' } })).toEqual([{ type: 'reasoning_delta', text: 'hmm' }])
    // a real tool streams through
    expect(a.map({ type: 'tool-call', payload: { toolCallId: 'c1', toolName: 'search', args: { q: 'x' } } })).toEqual([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'search', args: { q: 'x' } },
    ])
    expect(a.map({ type: 'tool-result', payload: { toolCallId: 'c1', toolName: 'search', result: 42 } })).toEqual([
      { type: 'tool_end', toolCallId: 'c1', result: 42, isError: false },
    ])
    // delegate is suppressed at the parent level (the child node stands in for it)
    expect(a.map({ type: 'tool-call', payload: { toolCallId: 'd1', toolName: 'delegate', args: {} } })).toEqual([])
    expect(a.map({ type: 'tool-result', payload: { toolCallId: 'd1', toolName: 'delegate', result: {} } })).toEqual([])
    a.map({ type: 'finish', payload: { output: { usage: { totalTokens: 5 } } } })
    expect(a.usage?.totalTokens).toBe(5)
  })

  it('captures cachedInputTokens from the finish chunk', () => {
    const a = createChunkAdapter(new Set())
    a.map({ type: 'finish', payload: { output: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 5, cachedInputTokens: 80 } } } })
    expect(a.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 5, cachedInputTokens: 80 })
  })

  it('accumulates step-finish deltas into a running usage event so the count ticks mid-turn', () => {
    const a = createChunkAdapter(new Set())
    const e1 = a.map({ type: 'step-finish', payload: { output: { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 } } } })
    expect(e1).toEqual([{ type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 0, cachedInputTokens: 80 } }])
    // second step accumulates onto the first (running total, not per-step delta)
    const e2 = a.map({ type: 'step-finish', payload: { output: { usage: { inputTokens: 50, outputTokens: 10 } } } })
    expect(e2).toEqual([{ type: 'usage', usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180, reasoningTokens: 0, cachedInputTokens: 80 } }])
  })

  it('maps tool-error to a settled tool_end so the call never sticks at input-available', () => {
    const a = createChunkAdapter(new Set())
    expect(a.map({ type: 'tool-error', payload: { toolCallId: 'c9', toolName: 'weather', error: new Error('boom') } })).toEqual([
      { type: 'tool_end', toolCallId: 'c9', result: 'boom', isError: true },
    ])
  })
})

describe('projector', () => {
  it('folds a parent+child event stream into per-node + thread Store docs', () => {
    const sink = memoryTreeSink()
    const p = new Projector(sink)
    const root = { nodeId: 'r', parentNodeId: null, depth: 0 }
    const child = { nodeId: 'c', parentNodeId: 'r', depth: 1, agentType: 'worker' }
    const ev: HarnessEvent[] = [
      { ...root, type: 'node_start' },
      { ...root, type: 'text_delta', text: 'plan ' },
      { ...child, type: 'node_start', task: 'do it' },
      { ...child, type: 'tool_start', toolCallId: 't1', toolName: 'search', args: {} },
      { ...child, type: 'tool_end', toolCallId: 't1', result: 'ok', isError: false },
      { ...child, type: 'node_end', reason: 'complete' },
      { ...root, type: 'text_delta', text: 'done' },
      { ...root, type: 'node_end', reason: 'complete' },
    ]
    for (const e of ev) p.emit(e)

    expect(sink.readNode('r')?.text).toBe('plan done')
    expect(sink.readNode('r')?.status).toBe('complete')
    expect(sink.readNode('c')?.agentType).toBe('worker')
    expect(sink.readNode('c')?.toolOrder).toEqual(['t1'])
    expect(sink.readNode('c')?.tools.t1.status).toBe('output-available')

    const thread = sink.readThread()!
    expect(thread.turns).toEqual(['r'])
    expect(thread.nodes.r.childOrder).toEqual(['c'])
    expect(thread.nodes.c.parentNodeId).toBe('r')

    // the projector also exposes the live tree (sink-less operation)
    expect(p.tree.nodes.r.text).toBe('plan done')
  })
})

// A fake runner whose stream yields the given chunks; if `delegate` is set it
// calls runtime.delegate mid-stream (simulating the delegate tool executing).
const fakeRunner =
  (chunks: ChunkLike[], delegateTo?: { type: string; task: string; toolCallId: string }) =>
  (_node: NodeEnvelope, runtime: HarnessRuntime): AgentRunner =>
  async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: 'start ' } }
      if (delegateTo) {
        const r = await runtime.delegate(delegateTo.type, delegateTo.task, delegateTo.toolCallId)
        yield { type: 'text-delta', payload: { text: `got:${r.content}` } }
      }
      for (const c of chunks) yield c
      yield { type: 'finish', payload: { output: { usage: { totalTokens: 7 } } } }
    })(),
  })

const engine = (registry: Map<string, SubagentEntry>, extra?: Partial<EngineConfig>): Harness =>
  new Harness({ supervisorType: 'supervisor', registry, maxDepth: 3, ...extra })

describe('harness: delegation + tree', () => {
  it('runs a turn, delegates to a subagent, and builds the tree', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      delegatesTo: ['worker'],
      makeRunner: fakeRunner([], { type: 'worker', task: 'do the thing', toolCallId: 'tc-1' }),
    })
    registry.set('worker', {
      agentType: 'worker',
      makeRunner: fakeRunner([
        { type: 'tool-call', payload: { toolCallId: 'w1', toolName: 'search', args: { q: 'a' } } },
        { type: 'tool-result', payload: { toolCallId: 'w1', toolName: 'search', result: 'found' } },
        { type: 'text-delta', payload: { text: 'report' } },
      ]),
    })

    const harness = engine(registry)
    const res = await harness.sendMessage({ threadId: 't1', content: 'hello' })
    expect(res).toMatchObject({ status: 'done', text: 'start got:start report', usage: { totalTokens: 7 } })

    const tree = harness.getTree('t1')!
    const rootId = tree.turns[0]
    expect(tree.nodes[rootId].childOrder).toEqual(['tc-1'])
    expect(tree.nodes['tc-1']).toMatchObject({ parentNodeId: rootId, agentType: 'worker', depth: 1 })
    expect(tree.nodes['tc-1'].toolOrder).toEqual(['w1'])
    expect(tree.nodes['tc-1'].text).toBe('start report')
    expect(tree.nodes[rootId].status).toBe('complete')
  })

  it('blocks delegation past maxDepth', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      delegatesTo: ['worker'],
      makeRunner: fakeRunner([], { type: 'worker', task: 't', toolCallId: 'tc-1' }),
    })
    registry.set('worker', {
      agentType: 'worker',
      delegatesTo: ['worker'],
      makeRunner: fakeRunner([], { type: 'worker', task: 't2', toolCallId: 'tc-2' }),
    })

    const harness = new Harness({ supervisorType: 'supervisor', registry, maxDepth: 1 })
    await harness.sendMessage({ threadId: 't1', content: 'go' })
    const tree = harness.getTree('t1')!
    expect(tree.nodes['tc-2']).toBeUndefined()
    expect(tree.nodes['tc-1'].text).toContain('got:max delegation depth')
  })

  it('blocks delegation to an agent outside delegatesTo', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      delegatesTo: ['critic'], // worker exists but is not an allowed edge
      makeRunner: fakeRunner([], { type: 'worker', task: 't', toolCallId: 'tc-1' }),
    })
    registry.set('worker', { agentType: 'worker', makeRunner: fakeRunner([]) })
    registry.set('critic', { agentType: 'critic', makeRunner: fakeRunner([]) })

    const harness = engine(registry)
    await harness.sendMessage({ threadId: 't1', content: 'go' })
    const tree = harness.getTree('t1')!
    expect(tree.nodes['tc-1']).toBeUndefined()
    expect(tree.nodes[tree.turns[0]].text).toContain("may not delegate to 'worker'")
  })
})

describe('harness: bus', () => {
  it('emits raw events then a synthetic tree_changed, and unsubscribes cleanly', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry)

    const seen: Array<{ threadId: string; type: string; task?: string }> = []
    const unsub = harness.subscribe((threadId, e) =>
      seen.push({ threadId, type: e.type, task: 'task' in e ? e.task : undefined }),
    )
    await harness.sendMessage({ threadId: 't1', content: 'hello' })

    const types = seen.map((s) => s.type)
    expect(types[0]).toBe('node_start')
    expect(seen[0].task).toBe('hello') // root turns carry the user message → tree is the full transcript
    expect(types[1]).toBe('tree_changed') // synthetic follows every node event
    expect(types).toContain('text_delta')
    expect(types).toContain('node_end')
    expect(seen.every((s) => s.threadId === 't1')).toBe(true)

    unsub()
    const before = seen.length
    await harness.sendMessage({ threadId: 't1', content: 'again' })
    expect(seen.length).toBe(before)
  })
})

describe('harness: follow-up queue + steer', () => {
  // a runner that parks until released, and honors abort (even if the signal
  // fired before the stream body started)
  const abortRejection = (signal?: AbortSignal) =>
    new Promise((_, reject) => {
      if (!signal) return
      if (signal.aborted) return reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const gatedRunner = (release: Promise<void>, out: string) =>
    (_node: NodeEnvelope, _rt: HarnessRuntime): AgentRunner =>
    async (opts: RunOptions) => ({
      fullStream: (async function* () {
        await Promise.race([release, abortRejection(opts.abortSignal)])
        yield { type: 'text-delta', payload: { text: out } }
      })(),
    })

  it('queues a message while running and drains it after the turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const registry = new Map<string, SubagentEntry>()
    let calls = 0
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: (node, rt) => {
        calls++
        return calls === 1 ? gatedRunner(gate, 'first')(node, rt) : fakeRunner([])(node, rt)
      },
    })
    const harness = engine(registry)
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    const p1 = harness.sendMessage({ threadId: 't1', content: 'one' })
    const r2 = await harness.sendMessage({ threadId: 't1', content: 'two' })
    expect(r2).toEqual({ status: 'queued', queued: 1 })
    expect(events.find((e) => e.type === 'follow_up_queued')).toMatchObject({ count: 1 })

    release()
    await p1
    // drain happens async — wait for the queued turn to finish
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(2)
    const drained = events.filter((e) => e.type === 'follow_up_queued')
    expect(drained.at(-1)).toMatchObject({ count: 0 })
  })

  it('steer aborts the running turn, clears the queue, and jumps in', async () => {
    const never = new Promise<void>(() => {})
    const registry = new Map<string, SubagentEntry>()
    let calls = 0
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: (node, rt) => {
        calls++
        return calls === 1 ? gatedRunner(never, 'first')(node, rt) : fakeRunner([])(node, rt)
      },
    })
    const harness = engine(registry)

    const p1 = harness.sendMessage({ threadId: 't1', content: 'one' })
    await harness.sendMessage({ threadId: 't1', content: 'stale' }) // queued, will be cleared
    const steered = await harness.steer({ threadId: 't1', content: 'do this instead' })

    const r1 = await p1
    expect(r1).toMatchObject({ status: 'error', error: 'aborted' })
    // the steer message was queued behind the dying run and drains after it
    expect(steered).toMatchObject({ status: 'queued' })
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(2) // 'stale' never ran
  })
})

describe('harness: suspension registry', () => {
  const suspendingRunner =
    () =>
    (_node: NodeEnvelope, _rt: HarnessRuntime): AgentRunner =>
    async (opts: RunOptions) => ({
      fullStream: (async function* () {
        if (opts.resumeData !== undefined) {
          yield { type: 'text-delta', payload: { text: `answered:${(opts.resumeData as { answer: string }).answer}` } }
          return
        }
        yield { type: 'text-delta', payload: { text: 'asking ' } }
        yield {
          type: 'tool-call-suspended',
          payload: { toolCallId: 'ask-1', toolName: 'ask_user', suspendPayload: { question: 'ok?' }, args: {} },
        }
      })(),
    })

  it('parks a suspension, emits the event, and resumes by registry', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: suspendingRunner() })
    const harness = engine(registry)
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    const res = await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(res.status).toBe('suspended')
    const suspended = events.find((e) => e.type === 'suspended')
    expect(suspended).toMatchObject({ toolCallId: 'ask-1', toolName: 'ask_user' })

    // implicit toolCallId resolution (exactly one parked)
    const resumed = await harness.resume({ threadId: 't1', resumeData: { answer: 'yes' } })
    expect(resumed).toMatchObject({ status: 'done', text: 'answered:yes' })
  })

  it('rejects resume with no parked suspension', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry)
    expect(() => harness.resume({ threadId: 't1', resumeData: {} })).toThrow('no parked suspension')
  })

  it('abort of a PARKED suspension settles its node as aborted in the tree', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: suspendingRunner() })
    const harness = engine(registry)
    const res = await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(res.status).toBe('suspended')

    const rootId = res.status === 'suspended' ? res.suspension.nodeId : ''
    expect(harness.getTree('t1')?.nodes[rootId]?.status).toBe('running') // parked, no node_end yet

    harness.abort('t1')
    expect(harness.getTree('t1')?.nodes[rootId]?.status).toBe('aborted') // settled — no phantom running turn
    expect(() => harness.resume({ threadId: 't1', resumeData: {} })).toThrow('no parked suspension')
  })

  it('a mid-turn resume is rejected WITHOUT destroying the parked suspension', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const registry = new Map<string, SubagentEntry>()
    let calls = 0
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: (node, rt) => {
        calls++
        if (calls === 1) return suspendingRunner()(node, rt) // first turn suspends
        if (calls === 2)
          return async () => ({
            // second turn parks until released
            fullStream: (async function* () {
              await gate
              yield { type: 'text-delta', payload: { text: 'second' } }
            })(),
          })
        return suspendingRunner()(node, rt) // the resume
      },
    })
    const harness = engine(registry)

    const first = await harness.sendMessage({ threadId: 't1', content: 'one' })
    expect(first.status).toBe('suspended')

    // a NEW turn starts while the suspension is parked (allowed)
    const second = harness.sendMessage({ threadId: 't1', content: 'two' })
    // resuming mid-turn must reject...
    expect(() => harness.resume({ threadId: 't1', resumeData: { answer: 'x' } })).toThrow('mid-turn')
    release()
    await second
    // ...and the suspension must still be resumable afterwards
    const resumed = await harness.resume({ threadId: 't1', resumeData: { answer: 'yes' } })
    expect(resumed).toMatchObject({ status: 'done', text: 'answered:yes' })
  })

  it('abort drops the follow-up queue', async () => {
    const never = new Promise<void>(() => {})
    const registry = new Map<string, SubagentEntry>()
    let calls = 0
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async (opts) => {
        calls++
        return {
          fullStream: (async function* () {
            await Promise.race([
              never,
              new Promise((_, reject) => {
                if (opts.abortSignal?.aborted) return reject(new Error('aborted'))
                opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))
              }),
            ])
            yield { type: 'text-delta', payload: { text: 'unreachable' } }
          })(),
        }
      },
    })
    const harness = engine(registry)
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    const p1 = harness.sendMessage({ threadId: 't1', content: 'one' })
    await harness.sendMessage({ threadId: 't1', content: 'queued' })
    harness.abort('t1')
    await p1
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(1) // the queued message never ran
    const queueEvents = events.filter((e) => e.type === 'follow_up_queued').map((e) => e.count)
    expect(queueEvents).toEqual([1, 0])
  })
})

describe('harness: tool approvals', () => {
  // Realistic Mastra semantics: the stream CLOSES on the approval chunk; the
  // continuation arrives as a fresh stream from approve/declineToolCall.
  const approvalRunner =
    () =>
    (_node: NodeEnvelope, _rt: HarnessRuntime): AgentRunner =>
    async () => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'pre ' } }
        yield { type: 'tool-call-approval', payload: { toolCallId: 'a1', toolName: 'dangerous', args: { x: 1 } } }
      })(),
    })
  const continuation = (text: string) => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text } }
      yield { type: 'finish', payload: { output: { usage: { totalTokens: 3 } } } }
    })(),
  })

  it('parks an ask-policy call, emits approval_required, and drives the continuation stream', async () => {
    const approvals: unknown[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: approvalRunner() })
    const harness = engine(registry, {
      permissions: { tools: { dangerous: 'ask' } },
      resolveToolCall: async (a) => {
        approvals.push(a)
        return continuation('done')
      },
    })

    let sawRequired = false
    harness.subscribe((_tid, e) => {
      if (e.type === 'approval_required') {
        sawRequired = true
        expect(e).toMatchObject({ toolCallId: 'a1', toolName: 'dangerous' })
        void harness.respondToApproval({ threadId: 't1', decision: 'approve' })
      }
    })

    const res = await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(sawRequired).toBe(true)
    // text spans both stream segments; the tree accumulated it on ONE node
    expect(res).toMatchObject({ status: 'done', text: 'pre done' })
    expect(approvals[0]).toMatchObject({ toolCallId: 'a1', approved: true })
    const tree = harness.getTree('t1')!
    expect(tree.turns).toHaveLength(1)
    expect(tree.nodes[tree.turns[0]].text).toBe('pre done')
    expect(tree.nodes[tree.turns[0]].status).toBe('complete')
  })

  it('auto-declines a deny-policy call without asking and keeps driving', async () => {
    const approvals: Array<{ approved: boolean }> = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: approvalRunner() })
    const harness = engine(registry, {
      permissions: { tools: { dangerous: 'deny' } },
      resolveToolCall: async (a) => {
        approvals.push(a)
        return continuation('declined-and-moved-on')
      },
    })
    let sawRequired = false
    harness.subscribe((_tid, e) => void (e.type === 'approval_required' && (sawRequired = true)))

    const res = await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(sawRequired).toBe(false)
    expect(approvals[0]).toMatchObject({ approved: false })
    expect(res).toMatchObject({ status: 'done', text: 'pre declined-and-moved-on' })
  })

  it('abort while a gate is parked does NOT resume the dead run', async () => {
    const approvals: unknown[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: approvalRunner() })
    const harness = engine(registry, {
      permissions: { tools: { dangerous: 'ask' } },
      resolveToolCall: async (a) => {
        approvals.push(a)
        return continuation('zombie')
      },
    })
    harness.subscribe((_tid, e) => {
      if (e.type === 'approval_required') harness.abort('t1')
    })
    const res = await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(res).toMatchObject({ status: 'error', error: 'aborted' })
    expect(approvals).toHaveLength(0) // no continuation was requested
  })

  it('always_allow grants skip future asks; per-tool deny beats yolo', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry, {
      permissions: { tools: { rm: 'deny' } },
      toolCategoryResolver: () => 'execute',
    })
    expect(harness.resolveToolApproval('t1', 'anything')).toBe('ask')
    harness.setYolo('t1', true)
    expect(harness.resolveToolApproval('t1', 'anything')).toBe('allow')
    expect(harness.resolveToolApproval('t1', 'rm')).toBe('deny') // deny beats yolo
    harness.setYolo('t1', false)
    expect(harness.resolveToolApproval('t1', 'todo')).toBe('allow') // built-ins never gate
  })
})

describe('harness: modes', () => {
  it('passes the current mode overlay to the supervisor runner and persists switches', async () => {
    const seenOpts: RunOptions[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async (opts) => {
        seenOpts.push(opts)
        return { fullStream: (async function* () {})() }
      },
    })
    const saved: ThreadRecord[] = []
    const store: ThreadStore = {
      createThread: async (a) => ({ id: a.threadId ?? 'x', resourceId: a.resourceId }),
      getThreadById: async ({ threadId }) => ({ id: threadId, resourceId: threadId, metadata: {} }),
      saveThread: async ({ thread }) => void saved.push(thread),
      deleteThread: async () => {},
      listThreads: async () => ({ threads: [] }),
    }
    const harness = engine(registry, {
      modes: [
        { id: 'plan', instructions: 'Plan only.', metadata: { default: true } },
        { id: 'build', instructions: 'Build it.', availableTools: ['write_file'] },
      ],
      threads: store,
    })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    expect(harness.getMode('t1')).toBe('plan')
    await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(seenOpts[0].modeInstructions).toBe('Plan only.')
    expect(seenOpts[0].activeTools).toBeUndefined()

    await harness.switchMode('t1', 'build')
    expect(events.find((e) => e.type === 'mode_changed')).toMatchObject({ modeId: 'build', previousModeId: 'plan' })
    expect(saved[0]?.metadata?.harnessModeId).toBe('build')

    await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(seenOpts[1].modeInstructions).toBe('Build it.')
    expect(seenOpts[1].activeTools).toEqual(['write_file'])

    await expect(harness.switchMode('t1', 'nope')).rejects.toThrow('unknown mode')
  })

  it('hydrates a persisted mode on first turn', async () => {
    const seenOpts: RunOptions[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async (opts) => {
        seenOpts.push(opts)
        return { fullStream: (async function* () {})() }
      },
    })
    const store: ThreadStore = {
      createThread: async (a) => ({ id: a.threadId ?? 'x', resourceId: a.resourceId }),
      getThreadById: async ({ threadId }) => ({
        id: threadId,
        resourceId: threadId,
        metadata: { harnessModeId: 'build' },
      }),
      saveThread: async () => {},
      deleteThread: async () => {},
      listThreads: async () => ({ threads: [] }),
    }
    const harness = engine(registry, {
      modes: [{ id: 'plan', instructions: 'Plan.' }, { id: 'build', instructions: 'Build.' }],
      threads: store,
    })
    await harness.sendMessage({ threadId: 't9', content: 'go' })
    expect(seenOpts[0].modeInstructions).toBe('Build.')
  })
})

describe('harness: per-turn request context', () => {
  const recordingRunner =
    (seen: RunOptions[], delegateTo?: { type: string; task: string; toolCallId: string }) =>
    (_node: NodeEnvelope, runtime: HarnessRuntime): AgentRunner =>
    async (opts) => {
      seen.push(opts)
      return {
        fullStream: (async function* () {
          if (delegateTo) await runtime.delegate(delegateTo.type, delegateTo.task, delegateTo.toolCallId)
          yield { type: 'text-delta', payload: { text: 'ok' } }
        })(),
      }
    }

  it('resolves the hook once per turn and hands the value to root AND child runners', async () => {
    const hookArgs: unknown[] = []
    const rootOpts: RunOptions[] = []
    const childOpts: RunOptions[] = []
    const token = { creds: 'omma-key', sceneId: 's1' }
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      delegatesTo: ['worker'],
      makeRunner: recordingRunner(rootOpts, { type: 'worker', task: 'build', toolCallId: 'tc-1' }),
    })
    registry.set('worker', { agentType: 'worker', makeRunner: recordingRunner(childOpts) })

    const harness = engine(registry, {
      modes: [{ id: 'ultra', metadata: { model1: 'opus', model2: 'sonnet' } }],
      requestContext: (args) => {
        hookArgs.push(args)
        return token
      },
    })
    const png = { url: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'logo.png' }
    await harness.sendMessage({ threadId: 't1', content: 'go', files: [png] })

    expect(hookArgs).toHaveLength(1)
    expect(hookArgs[0]).toMatchObject({
      threadId: 't1',
      resource: 't1',
      mode: { id: 'ultra', metadata: { model1: 'opus', model2: 'sonnet' } },
      files: [png], // the hook is the host's only server-side seam to attachments
    })
    expect(rootOpts[0].requestContext).toBe(token)
    expect(childOpts[0].requestContext).toBe(token)
  })

  it('re-resolves the hook on resume — per-turn state is rebuilt, not replayed', async () => {
    let calls = 0
    const seen: RunOptions[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async (opts) => {
        seen.push(opts)
        return {
          fullStream: (async function* () {
            if (opts.resumeData !== undefined) return
            yield {
              type: 'tool-call-suspended',
              payload: { toolCallId: 'ask-1', toolName: 'ask_user', suspendPayload: {}, args: {} },
            }
          })(),
        }
      },
    })
    const harness = engine(registry, { requestContext: () => ({ turn: ++calls }) })

    const res = await harness.sendMessage({ threadId: 't1', content: 'go' })
    expect(res.status).toBe('suspended')
    await harness.resume({ threadId: 't1', resumeData: { answer: 'yes' } })

    expect(calls).toBe(2)
    expect(seen[0].requestContext).toEqual({ turn: 1 })
    expect(seen[1].requestContext).toEqual({ turn: 2 })
  })

  it('a hook throw settles the turn as an errored node, without wedging the thread', async () => {
    let broken = true
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry, {
      requestContext: () => {
        if (broken) throw new Error('no credentials')
        return {}
      },
    })
    await expect(harness.sendMessage({ threadId: 't1', content: 'go' })).rejects.toThrow('no credentials')
    // The failure is VISIBLE in the tree (the wire fires sendMessage without
    // awaiting it — otherwise the message silently vanishes for clients).
    const tree = harness.getTree('t1')!
    expect(tree.turns).toHaveLength(1)
    expect(tree.nodes[tree.turns[0]]).toMatchObject({ status: 'error', error: 'no credentials' })
    broken = false
    const res = await harness.sendMessage({ threadId: 't1', content: 'again' })
    expect(res).toMatchObject({ status: 'done' }) // running flag was released
  })

  it('threads the turn context and node runtime into an approval continuation', async () => {
    const token = { creds: 'omma-key' }
    const resolveArgs: unknown[] = []
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async () => ({
        fullStream: (async function* () {
          yield { type: 'tool-call-approval', payload: { toolCallId: 'g1', toolName: 'clear_board', args: {} } }
        })(),
      }),
    })
    const harness = engine(registry, {
      permissions: { tools: { clear_board: 'ask' } },
      requestContext: () => token,
      resolveToolCall: async (args) => {
        resolveArgs.push(args)
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'done' } } })() }
      },
    })
    harness.subscribe((_tid, e) => {
      if (e.type === 'approval_required') void harness.respondToApproval({ threadId: 't1', decision: 'approve' })
    })

    const res = await harness.sendMessage({ threadId: 't1', content: 'wipe it' })
    expect(res).toMatchObject({ status: 'done', text: 'done' })
    expect(resolveArgs[0]).toMatchObject({ approved: true, requestContext: token })
    expect((resolveArgs[0] as { runtime?: unknown }).runtime).toBeDefined()
  })
})

describe('harness: file attachments', () => {
  it('rides files into the root RunOptions and preserves them on queued follow-ups', async () => {
    const seen: RunOptions[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let first = true
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: () => async (opts) => {
        seen.push(opts)
        const hold = first && (first = false)
        return {
          fullStream: (async function* () {
            if (hold) await gate
            yield { type: 'text-delta', payload: { text: 'ok' } }
          })(),
        }
      },
    })
    const harness = engine(registry)

    const png = { url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }
    const p1 = harness.sendMessage({ threadId: 't1', content: 'first', files: [png] })
    const queued = await harness.sendMessage({ threadId: 't1', content: 'second', files: [{ url: 'data:image/jpeg;base64,BBBB' }] })
    expect(queued).toMatchObject({ status: 'queued' })
    release()
    await p1
    await new Promise((r) => setTimeout(r, 0)) // let the drained follow-up start

    expect(seen[0].files).toEqual([png])
    expect(seen[1].files).toEqual([{ url: 'data:image/jpeg;base64,BBBB' }])
  })
})

describe('harness: threads facade', () => {
  it('lists/creates/renames/deletes through the store and emits events', async () => {
    const db = new Map<string, ThreadRecord>()
    const store: ThreadStore = {
      createThread: async (a) => {
        const t = { id: a.threadId ?? 'gen', resourceId: a.resourceId, title: a.title }
        db.set(t.id, t)
        return t
      },
      getThreadById: async ({ threadId }) => db.get(threadId) ?? null,
      saveThread: async ({ thread }) => void db.set(thread.id, thread),
      deleteThread: async (threadId) => void db.delete(threadId),
      listThreads: async ({ filter }) => ({
        threads: [...db.values()].filter((t) => !filter?.resourceId || t.resourceId === filter.resourceId),
      }),
    }
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry, { threads: store })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    const created = await harness.threads.create({ threadId: 'th-1', resourceId: 'res-1', title: 'First' })
    expect(created).toMatchObject({ id: 'th-1', title: 'First' })
    // Thread events carry resourceId so the server can target the resource room.
    expect(events.find((e) => e.type === 'thread_created')).toMatchObject({ threadId: 'th-1', resourceId: 'res-1' })

    await harness.threads.rename('th-1', 'Renamed')
    expect((await harness.threads.get('th-1'))?.title).toBe('Renamed')
    expect(events.find((e) => e.type === 'thread_renamed')).toMatchObject({ threadId: 'th-1', resourceId: 'res-1' })

    expect(await harness.threads.list()).toHaveLength(1)
    await harness.threads.delete('th-1')
    expect(await harness.threads.list()).toHaveLength(0)
    // resourceId is read BEFORE deletion so the event can still target the room.
    expect(events.find((e) => e.type === 'thread_deleted')).toMatchObject({ threadId: 'th-1', resourceId: 'res-1' })
  })

  it('throws a descriptive error without a store', async () => {
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry)
    await expect(harness.threads.list()).rejects.toThrow('requires a memory/threads store')
  })

  // Mastra's PostgresStore deletes the thread row, THEN throws clearing an
  // observational-memory table that was never created — so the row is gone but
  // deleteThread rejected. thread_deleted must still fire or every client keeps
  // the dead thread in its sidebar (this is the "delete doesn't propagate" bug).
  it('still emits thread_deleted when the store deletes the row then throws on cleanup', async () => {
    const db = new Map<string, ThreadRecord>()
    const store: ThreadStore = {
      createThread: async (a) => {
        const t = { id: a.threadId ?? 'gen', resourceId: a.resourceId, title: a.title }
        db.set(t.id, t)
        return t
      },
      getThreadById: async ({ threadId }) => db.get(threadId) ?? null,
      saveThread: async ({ thread }) => void db.set(thread.id, thread),
      deleteThread: async (threadId) => {
        db.delete(threadId) // row gone...
        throw new Error('CLEAR_OBSERVATIONAL_MEMORY_FAILED') // ...then cleanup throws
      },
      listThreads: async ({ filter }) => ({
        threads: [...db.values()].filter((t) => !filter?.resourceId || t.resourceId === filter.resourceId),
      }),
    }
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry, { threads: store })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    await harness.threads.create({ threadId: 'th-1', resourceId: 'res-1' })
    await expect(harness.threads.delete('th-1')).resolves.toBeUndefined()
    expect(events.find((e) => e.type === 'thread_deleted')).toMatchObject({ threadId: 'th-1', resourceId: 'res-1' })
  })

  // But a genuine failure that leaves the row in place must still throw and NOT
  // tell clients the thread is gone.
  it('re-throws and does not emit thread_deleted when the row survives the failure', async () => {
    const db = new Map<string, ThreadRecord>()
    const store: ThreadStore = {
      createThread: async (a) => {
        const t = { id: a.threadId ?? 'gen', resourceId: a.resourceId, title: a.title }
        db.set(t.id, t)
        return t
      },
      getThreadById: async ({ threadId }) => db.get(threadId) ?? null,
      saveThread: async ({ thread }) => void db.set(thread.id, thread),
      deleteThread: async () => {
        throw new Error('DELETE_THREAD_FAILED') // nothing deleted
      },
      listThreads: async ({ filter }) => ({
        threads: [...db.values()].filter((t) => !filter?.resourceId || t.resourceId === filter.resourceId),
      }),
    }
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    const harness = engine(registry, { threads: store })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    await harness.threads.create({ threadId: 'th-1', resourceId: 'res-1' })
    await expect(harness.threads.delete('th-1')).rejects.toThrow('DELETE_THREAD_FAILED')
    expect(events.find((e) => e.type === 'thread_deleted')).toBeUndefined()
  })
})

describe('harness: title generation', () => {
  const store = (): ThreadStore => {
    const db = new Map<string, ThreadRecord>()
    return {
      createThread: async (a) => {
        const t = { id: a.threadId ?? 'gen', resourceId: a.resourceId, title: a.title }
        db.set(t.id, t)
        return t
      },
      getThreadById: async ({ threadId }) => db.get(threadId) ?? null,
      saveThread: async ({ thread }) => void db.set(thread.id, thread),
      deleteThread: async (threadId) => void db.delete(threadId),
      listThreads: async ({ filter }) => ({
        threads: [...db.values()].filter((t) => !filter?.resourceId || t.resourceId === filter.resourceId),
      }),
    }
  }
  const registry = (): Map<string, SubagentEntry> => {
    const r = new Map<string, SubagentEntry>()
    r.set('supervisor', { agentType: 'supervisor', makeRunner: fakeRunner([]) })
    return r
  }

  it('generates a title from the first user message and dispatches thread_renamed', async () => {
    const threads = store()
    await threads.createThread({ threadId: 't1', resourceId: 't1' })
    let calls = 0
    const harness = engine(registry(), {
      threads,
      generateTitle: async (input) => {
        calls++
        return `Title for: ${input}`
      },
    })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    await harness.sendMessage({ threadId: 't1', content: 'hello there' })
    await new Promise((r) => setTimeout(r, 20)) // title gen is fire-and-forget

    expect(calls).toBe(1)
    expect((await threads.getThreadById({ threadId: 't1' }))?.title).toBe('Title for: hello there')
    expect(events.find((e) => e.type === 'thread_renamed')).toMatchObject({ threadId: 't1', title: 'Title for: hello there' })
  })

  it('does not regenerate a title once the thread already has one', async () => {
    const threads = store()
    await threads.createThread({ threadId: 't1', resourceId: 't1', title: 'Existing' })
    let calls = 0
    const harness = engine(registry(), {
      threads,
      generateTitle: async () => {
        calls++
        return 'New title'
      },
    })

    await harness.sendMessage({ threadId: 't1', content: 'hello again' })
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toBe(0)
    expect((await threads.getThreadById({ threadId: 't1' }))?.title).toBe('Existing')
  })

  it('does not generate a title for an empty-input turn (e.g. a resume continuation)', async () => {
    const threads = store()
    await threads.createThread({ threadId: 't1', resourceId: 't1' })
    let calls = 0
    const harness = engine(registry(), { threads, generateTitle: async () => (calls++, 'Title') })

    await harness.sendMessage({ threadId: 't1', content: '' })
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toBe(0)
  })

  it('materializes an unknown thread on its first send and dispatches thread_created with the resolved resourceId', async () => {
    const threads = store()
    const harness = engine(registry(), { threads, resourceFor: () => 'res-9' })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    await harness.sendMessage({ threadId: 't1', content: 'hello' })
    await harness.sendMessage({ threadId: 't1', content: 'again' })

    expect(events.filter((e) => e.type === 'thread_created')).toHaveLength(1)
    expect(events.find((e) => e.type === 'thread_created')).toMatchObject({ threadId: 't1', resourceId: 'res-9' })
    expect((await threads.getThreadById({ threadId: 't1' }))?.resourceId).toBe('res-9')
  })

  it('generates a title for an implicitly materialized thread (first send, no explicit create)', async () => {
    const threads = store()
    const harness = engine(registry(), {
      threads,
      generateTitle: async (input) => `Title for: ${input}`,
    })
    const events: HarnessBusEvent[] = []
    harness.subscribe((_tid, e) => events.push(e))

    await harness.sendMessage({ threadId: 't1', content: 'hi' })
    await new Promise((r) => setTimeout(r, 20))

    expect(events.find((e) => e.type === 'thread_renamed')).toMatchObject({ threadId: 't1', title: 'Title for: hi' })
    expect((await threads.getThreadById({ threadId: 't1' }))?.title).toBe('Title for: hi')
  })

  it('swallows a title-generation failure without crashing the turn', async () => {
    const threads = store()
    await threads.createThread({ threadId: 't1', resourceId: 't1' })
    const harness = engine(registry(), {
      threads,
      generateTitle: async () => {
        throw new Error('model unavailable')
      },
    })

    const result = await harness.sendMessage({ threadId: 't1', content: 'hello' })
    await new Promise((r) => setTimeout(r, 20))

    expect(result.status).toBe('done')
    expect((await threads.getThreadById({ threadId: 't1' }))?.title).toBeUndefined()
  })
})
