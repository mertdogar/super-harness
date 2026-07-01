// Batteries-included entrypoint: pass Mastra Agents + per-subagent config, get a
// running super-line server whose per-node/thread Stores stream + persist the
// tree. The consumer owns their Agents (models, memory, tools); the lib owns the
// controller, contract, Stores, the delegate/ask_user/todo built-ins, and the
// server-side fold.

import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import type { ToolsInput } from '@mastra/core/agent'
import { createSuperLineServer } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'
import { contract } from '@super-harness/shared'
import { Session, type SubagentEntry } from './session'
import { superlineTreeSink, type TreeSink } from './sink'
import { makeDelegateTool, askUserTool, todoTool } from './tools'
import type { AgentRunner, NodeEnvelope, StreamResult } from './run-node'
import { HARNESS_RUNTIME_KEY, type HarnessRuntime } from './runtime'

export interface SubagentConfig {
  agent: Agent
  recall?: boolean
  canDelegate?: boolean
  maxSteps?: number
}

export interface HarnessConfig {
  supervisor: Agent
  subagents?: SubagentConfig[]
  maxDepth?: number
  // Durable per-node/thread Store backend. sqlite (default) is the decided
  // durable choice; memory is for tests/dev. sqlite needs better-sqlite3 built
  // (`pnpm approve-builds`).
  storage?: { type: 'sqlite' | 'memory'; path?: string }
  // super-line transports, e.g. webSocketServerTransport({ server }). Kept opaque
  // so core never statically imports the (core-skewed) transport package.
  transports?: unknown[]
  authenticate?: (handshake: unknown) => { role: 'user'; ctx: { userId: string } }
}

export interface Harness {
  server: ReturnType<typeof createSuperLineServer>
  session: Session
}

export async function createHarness(config: HarnessConfig): Promise<Harness> {
  const maxDepth = config.maxDepth ?? 3
  const subs = config.subagents ?? []
  const agentTypes = subs.map((s) => s.agent.id)
  const delegateTool = makeDelegateTool(agentTypes)

  const buildTools = (node: NodeEnvelope, canDelegate: boolean): ToolsInput => {
    const t: Record<string, unknown> = { todo: todoTool }
    if (node.depth === 0) t.ask_user = askUserTool // root-only HITL
    if ((node.depth === 0 || canDelegate) && agentTypes.length > 0) t.delegate = delegateTool
    return t as ToolsInput
  }

  const runnerFactory =
    (agent: Agent, canDelegate: boolean) =>
    (node: NodeEnvelope, runtime: HarnessRuntime): AgentRunner =>
    async (opts) => {
      const rc = new RequestContext()
      rc.set(HARNESS_RUNTIME_KEY, runtime)
      const streamOpts = {
        memory: { thread: opts.threadId, resource: opts.resource },
        toolsets: { harness: buildTools(node, canDelegate) },
        maxSteps: opts.maxSteps,
        abortSignal: opts.abortSignal,
        requestContext: rc,
      }
      const out =
        opts.resumeData !== undefined
          ? await agent.resumeStream(opts.resumeData, streamOpts)
          : await agent.stream(opts.input, streamOpts)
      return out as unknown as StreamResult
    }

  const registry = new Map<string, SubagentEntry>()
  registry.set(config.supervisor.id, {
    agentType: config.supervisor.id,
    makeRunner: runnerFactory(config.supervisor, true),
  })
  for (const s of subs) {
    registry.set(s.agent.id, {
      agentType: s.agent.id,
      recall: s.recall,
      canDelegate: s.canDelegate,
      maxSteps: s.maxSteps,
      makeRunner: runnerFactory(s.agent, !!s.canDelegate),
    })
  }

  const backend = async () => {
    if ((config.storage?.type ?? 'sqlite') === 'memory') return memoryStoreServer()
    const { sqliteStoreServer } = await import('@super-line/store-sqlite')
    return sqliteStoreServer({ file: config.storage?.path ?? './harness.db' })
  }

  const server = createSuperLineServer(contract, {
    transports: (config.transports ?? []) as never,
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

  const session = new Session({
    supervisorType: config.supervisor.id,
    registry,
    maxDepth,
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
        void session.run(threadId, message).catch((e) => console.error('[harness] run failed', e))
        return { ok: true }
      },
      resumeMessage: async ({ threadId, resumeData }: { threadId: string; resumeData: unknown }) => {
        void session.resume(threadId, resumeData).catch((e) => console.error('[harness] resume failed', e))
        return { ok: true }
      },
      abort: async ({ threadId }: { threadId: string }) => {
        session.abort(threadId)
        return { ok: true }
      },
    },
    user: {},
  } as never)

  return { server, session }
}
