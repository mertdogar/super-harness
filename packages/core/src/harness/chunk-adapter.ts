// Maps a Mastra `fullStream` chunk to HarnessEvent bodies for ONE node. The
// same mapper runs at every depth — that's why subagents get full fidelity
// (reasoning + tool-input deltas), unlike AC's coarse subagent_* forwarding.
// Stateful per node run: it remembers which toolCallIds are `delegate` so the
// parent-level tool_* chunks for a delegation are suppressed (the child node
// stands in for that tool call).

import type { HarnessEventBody, TokenUsage } from '@super-harness/shared'

// Structural view of a fullStream chunk — the real ChunkType is assignable to
// this. ponytail: read the few fields we map rather than mirror ~50 variants.
export interface ChunkLike {
  type: string
  payload?: unknown
}

export interface Suspension {
  toolCallId: string
  toolName: string
  suspendPayload: unknown
  resumeSchema?: string
}

export interface ChunkAdapter {
  map(chunk: ChunkLike): HarnessEventBody[]
  usage: TokenUsage | undefined
  suspension: Suspension | undefined
}

export function createChunkAdapter(suppressToolNames: ReadonlySet<string>): ChunkAdapter {
  const suppressed = new Set<string>()
  const self: ChunkAdapter = { map, usage: undefined, suspension: undefined }

  function map(chunk: ChunkLike): HarnessEventBody[] {
    const p = (chunk.payload ?? {}) as Record<string, any>
    switch (chunk.type) {
      case 'text-delta':
        return p.text ? [{ type: 'text_delta', text: p.text }] : []
      case 'reasoning-delta':
        return p.text ? [{ type: 'reasoning_delta', text: p.text }] : []
      case 'tool-call-input-streaming-start':
        if (suppressToolNames.has(p.toolName)) {
          suppressed.add(p.toolCallId)
          return []
        }
        return [{ type: 'tool_input_start', toolCallId: p.toolCallId, toolName: p.toolName }]
      case 'tool-call-delta':
        if (suppressed.has(p.toolCallId)) return []
        return [{ type: 'tool_input_delta', toolCallId: p.toolCallId, argsTextDelta: p.argsTextDelta }]
      case 'tool-call':
        if (suppressToolNames.has(p.toolName)) {
          suppressed.add(p.toolCallId)
          return []
        }
        return [{ type: 'tool_start', toolCallId: p.toolCallId, toolName: p.toolName, args: p.args }]
      case 'tool-result':
        if (suppressed.has(p.toolCallId)) return []
        return [{ type: 'tool_end', toolCallId: p.toolCallId, result: p.result, isError: !!p.isError }]
      case 'tool-error':
        // A tool whose execute() threw — without this the call stays
        // input-available ("Running") in the tree forever.
        if (suppressed.has(p.toolCallId)) return []
        return [{ type: 'tool_end', toolCallId: p.toolCallId, result: errorMessage(p), isError: true }]
      case 'tool-call-suspended':
        self.suspension = {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          suspendPayload: p.suspendPayload,
          resumeSchema: p.resumeSchema,
        }
        return []
      case 'step-finish': {
        // Per-step usage DELTA (verified: the run-final `finish` equals the sum of
        // these). Accumulate a running total and tick the node so the count climbs
        // mid-turn instead of only at node_end.
        const u = p.output?.usage
        if (!u) return []
        self.usage = addUsage(self.usage, u)
        return [{ type: 'usage', usage: self.usage }]
      }
      case 'finish': {
        // Authoritative cumulative for node_end (== the accumulated step deltas).
        const u = p.output?.usage
        if (u) {
          self.usage = {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: u.totalTokens,
            reasoningTokens: u.reasoningTokens,
            cachedInputTokens: u.cachedInputTokens,
          }
        }
        return []
      }
      case 'error':
        return [{ type: 'error', message: errorMessage(p) }]
      default:
        return []
    }
  }

  return self
}

// Accumulate a per-step usage delta into a running total. totalTokens is
// recomputed from parts (matching shared/sumUsage), cached/reasoning summed.
function addUsage(a: TokenUsage | undefined, b: Record<string, any>): TokenUsage {
  const inputTokens = (a?.inputTokens ?? 0) + (b.inputTokens ?? 0)
  const outputTokens = (a?.outputTokens ?? 0) + (b.outputTokens ?? 0)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    reasoningTokens: (a?.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    cachedInputTokens: (a?.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  }
}

function errorMessage(p: Record<string, any>): string {
  const e = p.error ?? p
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return typeof e?.message === 'string' ? e.message : 'stream error'
}
