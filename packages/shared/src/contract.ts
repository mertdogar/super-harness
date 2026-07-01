// The super-line wire contract. The harness TREE does not ride the contract —
// it rides per-node/thread Stores (configured separately, client + server).
// The contract carries the turn control plane (join/sendMessage/resume/abort)
// and the one ephemeral signal that isn't state: a suspended (ask_user) prompt.

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
        input: z.object({ threadId: z.string(), resumeData: z.unknown() }),
        output: z.object({ ok: z.boolean() }),
      },
      abort: {
        input: z.object({ threadId: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
    serverToClient: {
      suspended: { payload: suspendedSchema },
    },
  },
  roles: {
    user: {},
  },
})

export type Contract = typeof contract
