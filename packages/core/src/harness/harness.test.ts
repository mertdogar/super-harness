import { describe, expect, it } from 'vitest'
import { createChunkAdapter } from './chunk-adapter'
import { Projector } from './projector'
import { memoryTreeSink } from './sink'
import { Session, type SubagentEntry } from './session'
import type { ChunkLike } from './chunk-adapter'
import type { HarnessEvent } from '@super-harness/shared'
import type { HarnessRuntime } from './runtime'
import type { AgentRunner, NodeEnvelope } from './run-node'

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
  })
})

describe('session', () => {
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

  it('runs a turn, delegates to a subagent, and builds the tree in the Store', async () => {
    const sink = memoryTreeSink()
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
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

    const session = new Session({ supervisorType: 'supervisor', registry, maxDepth: 3, sinkFor: () => sink })
    await session.run('t1', 'hello')

    const thread = sink.readThread()!
    const rootId = thread.turns[0]
    expect(thread.nodes[rootId].childOrder).toEqual(['tc-1'])

    const child = sink.readNode('tc-1')!
    expect(child.parentNodeId).toBe(rootId)
    expect(child.agentType).toBe('worker')
    expect(child.depth).toBe(1)
    expect(child.toolOrder).toEqual(['w1'])
    expect(child.text).toBe('start report')

    const root = sink.readNode(rootId)!
    expect(root.status).toBe('complete')
    expect(root.text).toBe('start got:start report') // parent saw the child's returned report
  })

  it('blocks delegation past maxDepth', async () => {
    const sink = memoryTreeSink()
    const registry = new Map<string, SubagentEntry>()
    registry.set('supervisor', {
      agentType: 'supervisor',
      makeRunner: fakeRunner([], { type: 'worker', task: 't', toolCallId: 'tc-1' }),
    })
    // worker tries to delegate again -> would be depth 2, over maxDepth 1
    registry.set('worker', {
      agentType: 'worker',
      makeRunner: fakeRunner([], { type: 'worker', task: 't2', toolCallId: 'tc-2' }),
    })

    const session = new Session({ supervisorType: 'supervisor', registry, maxDepth: 1, sinkFor: () => sink })
    await session.run('t1', 'go')

    // depth-2 child never created; its would-be node id is absent
    expect(sink.readNode('tc-2')).toBeUndefined()
    expect(sink.readNode('tc-1')?.text).toContain('got:max delegation depth')
  })
})
