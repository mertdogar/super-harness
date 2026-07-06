// The super-line wire layer. super-harness ships as a super-line PLUGIN: this
// module exports `harnessContract()` — a `defineContractPlugin` fragment a host
// merges via `defineContract({ plugins: [harnessContract()] })` — plus a
// standalone `contract` for serve()/tui.
//
// The tree rides typed COLLECTIONS (ADR-0006), not Stores: `harness.threads`,
// `harness.nodes`, `harness.tools`, `harness.membership`. Structural state
// persists to rows; the token stream (reasoning/text/argsText deltas) rides
// ephemeral room EVENTS (harness.reasoningDelta/textDelta/toolInputDelta) and
// is never persisted per-token — the final strings land on the row at node_end.
// Every identifier is `harness.`-prefixed to compose beside a host's own
// surface/collections without collision.

import { z } from 'zod'
import { defineContract, defineContractPlugin, defineSurface } from '@super-line/core'
import { tokenUsageSchema, todoItemSchema } from './events'

// ── ephemeral signals (ride events, not state) ───────────────────────────────

export const suspendedSchema = z.object({
  threadId: z.string(),
  nodeId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  request: z.unknown().optional(),
  resumeSchema: z.string().optional(),
})
export type Suspended = z.infer<typeof suspendedSchema>

export const approvalRequiredSchema = z.object({
  threadId: z.string(),
  nodeId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown().optional(),
})
export type ApprovalRequired = z.infer<typeof approvalRequiredSchema>

export const approvalDecisionSchema = z.enum(['approve', 'decline', 'always_allow', 'always_allow_category'])
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>

export const modeInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
})
export type ModeInfo = z.infer<typeof modeInfoSchema>

export const threadInfoSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  title: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
})
export type ThreadInfo = z.infer<typeof threadInfoSchema>

// ── collection row schemas (the durable tree) ────────────────────────────────

export const nodeStatusSchema = z.enum(['running', 'complete', 'aborted', 'error'])
export const toolStatusSchema = z.enum(['input-streaming', 'input-available', 'output-available', 'error'])

// harness.threads — conversation skeleton (structure + metadata; content lives
// on node/tool rows). `resourceId` is an optional sidebar-grouping key,
// decoupled from security (membership is the security spine).
export const threadRowSchema = z.object({
  id: z.string(), // = threadId
  resourceId: z.string().optional(),
  title: z.string().optional(),
  turns: z.array(z.string()), // root nodeIds
  todos: z.array(todoItemSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ThreadRow = z.infer<typeof threadRowSchema>

// harness.nodes — one row per agent node (adjacency list via parentNodeId).
// `reasoning`/`text` are the FINAL strings (written at node_end); the live
// stream rides token-delta events. `pendingResume` makes a suspension
// reconstructable on reload (set on suspend, cleared on resume).
export const nodeRowSchema = z.object({
  id: z.string(), // = nodeId
  threadId: z.string(),
  parentNodeId: z.string().nullable(),
  depth: z.number(),
  agentType: z.string().optional(),
  task: z.string().optional(),
  status: nodeStatusSchema,
  reasoning: z.string(),
  text: z.string(),
  toolOrder: z.array(z.string()),
  childOrder: z.array(z.string()),
  usage: tokenUsageSchema.optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  textOffset: z.number().optional(),
  pendingResume: z.object({ resumeSchema: z.string().optional(), request: z.unknown().optional() }).optional(),
})
export type NodeRow = z.infer<typeof nodeRowSchema>

// harness.tools — one row per tool call (its own collection so per-token
// argsText writes don't rewrite the node's blob, and tools are queryable
// across a thread — e.g. pending approvals).
export const toolRowSchema = z.object({
  id: z.string(), // = toolCallId
  threadId: z.string(),
  nodeId: z.string(),
  toolName: z.string(),
  status: toolStatusSchema,
  argsText: z.string(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
  textOffset: z.number().optional(),
})
export type ToolRow = z.infer<typeof toolRowSchema>

// harness.membership — the RLS spine. A user reads a thread's node/tool rows iff
// they have a membership row for it. `role` gates control (viewer watches,
// operator drives) per-run.
export const memberRoleSchema = z.enum(['viewer', 'operator'])
export type MemberRole = z.infer<typeof memberRoleSchema>
export const membershipRowSchema = z.object({
  id: z.string(), // = `${threadId}:${userId}`
  threadId: z.string(),
  userId: z.string(),
  role: memberRoleSchema,
  joinedAt: z.number(),
})
export type MembershipRow = z.infer<typeof membershipRowSchema>

// Collection names + room helpers, exported so server, clients, and host apps
// share one spelling (a typo'd name is a silently dead handle).
export const HARNESS_THREADS = 'harness.threads'
export const HARNESS_NODES = 'harness.nodes'
export const HARNESS_TOOLS = 'harness.tools'
export const HARNESS_MEMBERSHIP = 'harness.membership'
export const membershipId = (threadId: string, userId: string): string => `${threadId}:${userId}`
export const harnessThreadRoom = (threadId: string): string => `harness:thread:${threadId}`
export const harnessResourceRoom = (resourceId: string): string => `harness:resource:${resourceId}`

// ── request + event defs ─────────────────────────────────────────────────────

const okOut = z.object({ ok: z.boolean() })

// clientToServer requests — all `shared` (rooms broadcast shared events, and a
// mixed-role room needs shared handlers). Control authz is a membership-role
// check inside the handler, NOT a contract-role split.
const requests = {
  'harness.join': { input: z.object({ threadId: z.string() }), output: okOut },
  'harness.sendMessage': { input: z.object({ threadId: z.string(), message: z.string() }), output: okOut },
  'harness.resumeMessage': {
    input: z.object({ threadId: z.string(), toolCallId: z.string().optional(), resumeData: z.unknown() }),
    output: okOut,
  },
  'harness.abort': { input: z.object({ threadId: z.string() }), output: okOut },
  'harness.respondToApproval': {
    input: z.object({
      threadId: z.string(),
      toolCallId: z.string().optional(),
      decision: approvalDecisionSchema,
      message: z.string().optional(),
    }),
    output: okOut,
  },
  'harness.switchMode': { input: z.object({ threadId: z.string(), modeId: z.string() }), output: okOut },
  'harness.listModes': {
    input: z.object({}),
    output: z.object({ modes: z.array(modeInfoSchema), defaultModeId: z.string().optional() }),
  },
  'harness.listThreads': {
    input: z.object({ resourceId: z.string().optional() }),
    output: z.object({ threads: z.array(threadInfoSchema) }),
  },
  'harness.createThread': {
    input: z.object({ threadId: z.string().optional(), resourceId: z.string().optional(), title: z.string().optional() }),
    output: z.object({ threadId: z.string() }),
  },
  'harness.renameThread': { input: z.object({ threadId: z.string(), title: z.string() }), output: okOut },
  'harness.deleteThread': { input: z.object({ threadId: z.string() }), output: okOut },
}

// serverToClient events. Session signals + the ephemeral token stream. Thread
// LIST reactivity is gone — it rides `harness.threads` collection row deltas now.
const events = {
  'harness.suspended': { payload: suspendedSchema },
  'harness.approvalRequired': { payload: approvalRequiredSchema },
  'harness.modeChanged': {
    payload: z.object({ threadId: z.string(), modeId: z.string(), previousModeId: z.string() }),
  },
  'harness.followUpQueued': { payload: z.object({ threadId: z.string(), count: z.number() }) },
  // Ephemeral token preview — broadcast to the per-thread room, never persisted.
  'harness.reasoningDelta': { payload: z.object({ threadId: z.string(), nodeId: z.string(), text: z.string() }) },
  'harness.textDelta': { payload: z.object({ threadId: z.string(), nodeId: z.string(), text: z.string() }) },
  'harness.toolInputDelta': {
    payload: z.object({ threadId: z.string(), nodeId: z.string(), toolCallId: z.string(), argsTextDelta: z.string() }),
  },
}

// The harness surface as a defineSurface value — used both in the contract
// fragment's `shared` block and as the paired-surface type param for the runtime
// `harness()` plugin (its handlers compile against this).
export const harnessSurface = defineSurface({
  clientToServer: requests,
  serverToClient: events,
})
export type HarnessSurface = typeof harnessSurface

// The contract-time half of the harness plugin. Merge into a host contract:
//   defineContract({ plugins: [harnessContract(), authContract()], roles: {...} })
// It contributes the 4 collections + the harness surface on `shared`. Handler
// keys are subtracted from the host's implement() obligation by the runtime
// plugin (@super-harness/server `harness()`).
export function harnessContract() {
  return defineContractPlugin('harness', {
    collections: {
      [HARNESS_THREADS]: { schema: threadRowSchema, key: 'id' },
      [HARNESS_NODES]: {
        schema: nodeRowSchema,
        key: 'id',
        references: { threadId: HARNESS_THREADS, parentNodeId: HARNESS_NODES },
      },
      [HARNESS_TOOLS]: {
        schema: toolRowSchema,
        key: 'id',
        references: { threadId: HARNESS_THREADS, nodeId: HARNESS_NODES },
      },
      [HARNESS_MEMBERSHIP]: {
        schema: membershipRowSchema,
        key: 'id',
        references: { threadId: HARNESS_THREADS },
      },
    },
    shared: harnessSurface,
  })
}

// The standalone contract serve()/tui run — the fragment materialized with a
// single `user` role, exactly as a host would merge it.
export const contract = defineContract({
  plugins: [harnessContract()],
  roles: { user: {} },
})

export type Contract = typeof contract
