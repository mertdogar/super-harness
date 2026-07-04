// Internal turn protocol: one discriminated union the controller emits as it
// folds each node's model stream. Every event carries the node envelope, so a
// tree of agents reconstructs from a flat stream. Unlike the @omma original
// there is no `seq` — delivery is via the per-node super-line Store (single
// writer per node = ordered), not a seq-ordered event feed. zod only.

import { z } from 'zod'

export const tokenUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
})
export type TokenUsage = z.infer<typeof tokenUsageSchema>

export const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export type TodoItem = z.infer<typeof todoItemSchema>

// nodeId = runId for a turn root, = the spawning delegate toolCallId for a child.
const envelope = {
  nodeId: z.string(),
  parentNodeId: z.string().nullable(),
  depth: z.number(),
  agentType: z.string().optional(),
}

export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('node_start'), task: z.string().optional(), modelId: z.string().optional() }),
  z.object({
    ...envelope,
    type: z.literal('node_end'),
    reason: z.enum(['complete', 'aborted', 'error']),
    usage: tokenUsageSchema.optional(),
    durationMs: z.number().optional(),
  }),
  z.object({ ...envelope, type: z.literal('reasoning_delta'), text: z.string() }),
  z.object({ ...envelope, type: z.literal('text_delta'), text: z.string() }),
  // *_done are the coalesced blocks the headless emits from consecutive deltas
  // (one clean line per block); the live stream + Store use the *_delta variants.
  z.object({ ...envelope, type: z.literal('reasoning_done'), text: z.string() }),
  z.object({ ...envelope, type: z.literal('text_done'), text: z.string() }),
  z.object({ ...envelope, type: z.literal('tool_input_start'), toolCallId: z.string(), toolName: z.string() }),
  z.object({ ...envelope, type: z.literal('tool_input_delta'), toolCallId: z.string(), argsTextDelta: z.string() }),
  z.object({ ...envelope, type: z.literal('tool_start'), toolCallId: z.string(), toolName: z.string(), args: z.unknown() }),
  z.object({ ...envelope, type: z.literal('tool_end'), toolCallId: z.string(), result: z.unknown(), isError: z.boolean() }),
  z.object({ ...envelope, type: z.literal('todo'), items: z.array(todoItemSchema) }),
  z.object({ ...envelope, type: z.literal('error'), message: z.string() }),
])

export type HarnessEvent = z.infer<typeof harnessEventSchema>
export type HarnessEventType = HarnessEvent['type']

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

// A node-scoped emitter stamps the envelope, so call sites pass only the variant.
export type HarnessEventBody = DistributiveOmit<HarnessEvent, 'nodeId' | 'parentNodeId' | 'depth' | 'agentType'>
