// The super-line wire contract. The harness TREE does not ride the contract —
// it rides per-node/thread Stores (configured separately, client + server).
// The contract carries the control plane (turns, approvals, modes, threads)
// and the ephemeral signals that aren't state: suspended / approval prompts.

import { z } from 'zod'
import { defineContract } from '@super-line/core'

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

export const contract = defineContract({
  shared: {
    clientToServer: {
      join: {
        input: z.object({ threadId: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      sendMessage: {
        input: z.object({ threadId: z.string(), message: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      resumeMessage: {
        input: z.object({ threadId: z.string(), toolCallId: z.string().optional(), resumeData: z.unknown() }),
        output: z.object({ ok: z.boolean() }),
      },
      abort: {
        input: z.object({ threadId: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      respondToApproval: {
        input: z.object({
          threadId: z.string(),
          toolCallId: z.string().optional(),
          decision: approvalDecisionSchema,
          message: z.string().optional(),
        }),
        output: z.object({ ok: z.boolean() }),
      },
      switchMode: {
        input: z.object({ threadId: z.string(), modeId: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      listModes: {
        input: z.object({}),
        output: z.object({ modes: z.array(modeInfoSchema), defaultModeId: z.string().optional() }),
      },
      listThreads: {
        input: z.object({ resourceId: z.string().optional() }),
        output: z.object({ threads: z.array(threadInfoSchema) }),
      },
      createThread: {
        input: z.object({ threadId: z.string().optional(), resourceId: z.string().optional(), title: z.string().optional() }),
        output: z.object({ threadId: z.string() }),
      },
      renameThread: {
        input: z.object({ threadId: z.string(), title: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
      deleteThread: {
        input: z.object({ threadId: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
    serverToClient: {
      suspended: { payload: suspendedSchema },
      approvalRequired: { payload: approvalRequiredSchema },
      modeChanged: { payload: z.object({ threadId: z.string(), modeId: z.string(), previousModeId: z.string() }) },
      followUpQueued: { payload: z.object({ threadId: z.string(), count: z.number() }) },
      threadRenamed: { payload: z.object({ threadId: z.string(), title: z.string() }) },
    },
  },
  roles: {
    user: {},
  },
})

export type Contract = typeof contract
