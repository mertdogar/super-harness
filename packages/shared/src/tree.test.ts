import { describe, expect, it } from 'vitest'
import { apply, initialTree } from './tree'
import type { HarnessEvent } from './events'

describe('tree.apply', () => {
  it('parses streamed tool input (argsText) into args when the tool-call omits them', () => {
    const tree = initialTree()
    const env = { nodeId: 'r', parentNodeId: null, depth: 0 }
    const evs: HarnessEvent[] = [
      { ...env, type: 'node_start' },
      { ...env, type: 'tool_input_start', toolCallId: 't1', toolName: 'weather' },
      { ...env, type: 'tool_input_delta', toolCallId: 't1', argsTextDelta: '{"city":' },
      { ...env, type: 'tool_input_delta', toolCallId: 't1', argsTextDelta: '"NYC"}' },
      { ...env, type: 'tool_start', toolCallId: 't1', toolName: 'weather', args: undefined },
    ]
    for (const e of evs) apply(tree, e)
    expect(tree.nodes.r.tools.t1.args).toEqual({ city: 'NYC' })
  })

  it('keeps explicit args from a non-streamed tool-call', () => {
    const tree = initialTree()
    const env = { nodeId: 'r', parentNodeId: null, depth: 0 }
    apply(tree, { ...env, type: 'node_start' })
    apply(tree, { ...env, type: 'tool_start', toolCallId: 't1', toolName: 'weather', args: { city: 'LA' } })
    expect(tree.nodes.r.tools.t1.args).toEqual({ city: 'LA' })
  })

  it('patches node usage from an interim usage event (mid-turn tick), before node_end', () => {
    const tree = initialTree()
    const env = { nodeId: 'r', parentNodeId: null, depth: 0 }
    apply(tree, { ...env, type: 'node_start' })
    apply(tree, { ...env, type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })
    expect(tree.nodes.r.status).toBe('running') // ticked while still running
    expect(tree.nodes.r.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })
  })
})
