// The super-line wire contract. The harness TREE does not ride the contract —
// it rides per-node/thread Stores (configured separately, client + server).
// The contract carries the control plane (turns, approvals, modes, threads)
// and the ephemeral signals that aren't state: suspended / approval prompts.
//
// Every identifier the harness registers on a super-line server is prefixed
// (`harness.*` requests/events/stores, `harness:*` rooms) — the composition
// convention that lets a host app mount `harnessSurface` beside its own
// surface on ONE server/socket without collisions.

import { z } from 'zod'
import { defineContract, defineSurface } from '@super-line/core'

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

// Store namespaces + room names, exported so server, clients, and host apps
// share one spelling (a typo'd store name is a silently dead handle).
export const HARNESS_NODE_STORE = 'harness.node'
export const HARNESS_THREAD_STORE = 'harness.thread'
export const harnessThreadRoom = (threadId: string): string => `harness:thread:${threadId}`
export const harnessResourceRoom = (resourceId: string): string => `harness:resource:${resourceId}`

// The composable contract fragment. A host app merges it into its SHARED block
// (`shared: mergeSurfaces(harnessSurface, ownShared)`) and mounts the handlers
// with @super-harness/server's mountHarness(); the standalone serve() mounts
// the SAME fragment — one wire ABI either way. It must ride `shared`, not a
// role: super-line rooms are mixed-role, so `room().broadcast` only carries
// shared events — and every harness signal is a room broadcast.
export const harnessSurface = defineSurface({
  clientToServer: {
    'harness.join': {
      input: z.object({ threadId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    'harness.sendMessage': {
      input: z.object({ threadId: z.string(), message: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    'harness.resumeMessage': {
      input: z.object({ threadId: z.string(), toolCallId: z.string().optional(), resumeData: z.unknown() }),
      output: z.object({ ok: z.boolean() }),
    },
    'harness.abort': {
      input: z.object({ threadId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    'harness.respondToApproval': {
      input: z.object({
        threadId: z.string(),
        toolCallId: z.string().optional(),
        decision: approvalDecisionSchema,
        message: z.string().optional(),
      }),
      output: z.object({ ok: z.boolean() }),
    },
    'harness.switchMode': {
      input: z.object({ threadId: z.string(), modeId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
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
    'harness.renameThread': {
      input: z.object({ threadId: z.string(), title: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    'harness.deleteThread': {
      input: z.object({ threadId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
  },
  serverToClient: {
    'harness.suspended': { payload: suspendedSchema },
    'harness.approvalRequired': { payload: approvalRequiredSchema },
    'harness.modeChanged': { payload: z.object({ threadId: z.string(), modeId: z.string(), previousModeId: z.string() }) },
    'harness.followUpQueued': { payload: z.object({ threadId: z.string(), count: z.number() }) },
    // Thread-LIST signals (the sidebar), broadcast to the resource room so all
    // of a resource's tabs stay in sync — not the per-thread room (a tab
    // viewing thread A must still learn thread B was created/renamed/deleted).
    'harness.threadCreated': { payload: threadInfoSchema },
    'harness.threadRenamed': { payload: z.object({ threadId: z.string(), title: z.string() }) },
    'harness.threadDeleted': { payload: z.object({ threadId: z.string() }) },
  },
})

// The standalone contract serve() runs — the fragment mounted into `shared`
// with a single empty role, exactly as a host would mount it.
export const contract = defineContract({
  shared: harnessSurface,
  roles: {
    user: {},
  },
})

export type Contract = typeof contract
