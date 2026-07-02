// Batteries-included entrypoint: pass Mastra Agents + per-subagent config, get a
// running super-line server whose per-node/thread Stores stream + persist the
// tree. The consumer owns their Agents (models, memory, tools); core owns the
// Controller and built-ins; this package owns the contract, Stores, transports,
// and the server-side fold.

import type { Agent } from '@mastra/core/agent'
import type { ServerTransport } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'
import { contract } from '@super-harness/shared'
import { createController, type Controller, type SubagentConfig, type TreeSink } from '@super-harness/core'
import { superlineTreeSink } from './sink'

export type { SubagentConfig }

export interface HarnessConfig {
  supervisor: Agent
  delegatesTo?: string[] | true
  subagents?: SubagentConfig[]
  maxDepth?: number
  // Durable per-node/thread Store backend. sqlite (default) is the decided
  // durable choice; memory is for tests/dev. sqlite needs better-sqlite3 built
  // (`pnpm approve-builds`).
  storage?: { type: 'sqlite' | 'memory'; path?: string }
  transports?: ServerTransport[]
  authenticate?: (handshake: unknown) => { role: 'user'; ctx: { userId: string } }
}

export interface Harness {
  server: ReturnType<typeof createSuperLineServer>
  controller: Controller
}

export async function createHarness(config: HarnessConfig): Promise<Harness> {
  const backend = async () => {
    if ((config.storage?.type ?? 'sqlite') === 'memory') return memoryStoreServer()
    const { sqliteStoreServer } = await import('@super-line/store-sqlite')
    return sqliteStoreServer({ file: config.storage?.path ?? './harness.db' })
  }

  const server = createSuperLineServer(contract, {
    transports: config.transports ?? [],
    authenticate:
      config.authenticate ??
      ((h: unknown) => ({ role: 'user' as const, ctx: { userId: (h as any)?.query?.userId ?? 'local' } })),
    identify: (conn: { ctx: { userId: string } }) => conn.ctx.userId,
    stores: { node: await backend(), thread: await backend() },
  } as never)

  const threadPrincipals = new Map<string, Set<string>>()
  const sinkFor = (threadId: string): TreeSink =>
    superlineTreeSink({
      nodeStore: server.store('node') as never,
      threadStore: server.store('thread') as never,
      threadId,
      grantTo: [...(threadPrincipals.get(threadId) ?? new Set())],
    })

  const controller = createController({
    supervisor: config.supervisor,
    delegatesTo: config.delegatesTo,
    subagents: config.subagents,
    maxDepth: config.maxDepth,
    sinkFor,
    onSuspended: (threadId, s) =>
      server.room(`thread:${threadId}`).broadcast('suspended', {
        threadId,
        nodeId: s.nodeId,
        toolCallId: s.toolCallId,
        toolName: s.toolName,
        request: s.suspendPayload,
        resumeSchema: s.resumeSchema,
      }),
  })

  server.implement({
    shared: {
      join: async ({ threadId }: { threadId: string }, ctx: { userId: string }, conn: unknown) => {
        server.room(`thread:${threadId}`).add(conn as never)
        const set = threadPrincipals.get(threadId) ?? new Set<string>()
        set.add(ctx.userId)
        threadPrincipals.set(threadId, set)
        // Pre-create the thread Resource granted to this connection — a client
        // open() on a not-yet-existent Resource is a dead handle, so it must exist
        // (and be readable) before the client subscribes.
        const store = server.store('thread') as unknown as {
          create(id: string, data: unknown, rules: unknown): Promise<void>
          grant?(id: string, principal: string, perms: unknown): Promise<void>
        }
        await store.create(threadId, { turns: [], nodes: {} }, { [ctx.userId]: { read: true } }).catch(() => {})
        await store.grant?.(threadId, ctx.userId, { read: true }).catch(() => {})
        return { ok: true }
      },
      sendMessage: async ({ threadId, message }: { threadId: string; message: string }) => {
        void controller.run(threadId, message).catch((e) => console.error('[harness] run failed', e))
        return { ok: true }
      },
      resumeMessage: async ({ threadId, resumeData }: { threadId: string; resumeData: unknown }) => {
        void controller.resume(threadId, resumeData).catch((e) => console.error('[harness] resume failed', e))
        return { ok: true }
      },
      abort: async ({ threadId }: { threadId: string }) => {
        controller.abort(threadId)
        return { ok: true }
      },
    },
    user: {},
  } as never)

  return { server, controller }
}
