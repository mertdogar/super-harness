// The harness() super-line PLUGIN — the runtime half paired with shared's
// harnessContract() fragment. Contributes:
//   policies  membership-based RLS: a user reads a thread's node/tool rows only
//             if they hold a membership row; the thread LIST is scoped by resourceId.
//   handlers  the harness.* requests (subtracted from the host's implement()).
//             Control ops (send/resume/abort/approve/switchMode/delete) reject a
//             `viewer` membership; read ops don't.
//   setup     subscribes the harness bus: token deltas broadcast to the per-thread
//             room (ephemeral, never persisted); structural events fold through a
//             Projector into the collections writer; session signals broadcast +
//             thread metadata/pendingResume persist; thread_deleted cascades.
//
// Auth-agnostic: it reads ctx.userId (the principal) however the host supplies it
// (query-param dev auth, @super-line/plugin-auth, or the host's own scheme).

import { SuperLineError, eq, isIn, or } from '@super-line/core'
import type { Conn, PluginContext, SuperLinePlugin } from '@super-line/server'
import { Projector, type Harness } from '@super-harness/core'
import {
  HARNESS_THREADS,
  HARNESS_NODES,
  HARNESS_TOOLS,
  HARNESS_MEMBERSHIP,
  membershipId,
  harnessThreadRoom,
  type ApprovalDecision,
  type HarnessSurface,
  type MemberRole,
  type MembershipRow,
} from '@super-harness/shared'
import { collectionsTreeSink, type CollectionsTreeSink } from './sink'

// What every connection's ctx must carry — the host's authenticate() shapes it.
// userId is the collection principal (RLS keys on it); resourceId (when present)
// scopes the thread list. With @super-line/plugin-auth, identify returns userId.
export interface HarnessCtx {
  userId: string
  resourceId?: string
  roles?: string[]
}

export interface HarnessPluginOptions {
  // Membership role a connection gets when it joins a thread. Default 'operator'
  // (every joiner can drive — preserves single-user behavior); return 'viewer'
  // to make a connection a read-only watcher of that run.
  roleFor?: (ctx: HarnessCtx) => MemberRole
  defaultRole?: MemberRole
}

// A structural view of the bus event — the plugin only reads these fields.
type BusEvent = {
  type: string
  nodeId?: string
  toolCallId?: string
  toolName?: string
  argsTextDelta?: string
  text?: string
  request?: unknown
  resumeSchema?: string
  args?: unknown
  modeId?: string
  previousModeId?: string
  count?: number
  resourceId?: string
  title?: string
}

export function harness(engine: Harness, opts: HarnessPluginOptions = {}): SuperLinePlugin<HarnessSurface> {
  let pctx: PluginContext | undefined
  const P = (): PluginContext => {
    if (!pctx) throw new Error('harness plugin: setup() has not run yet')
    return pctx
  }
  const col = (name: string) => P().collection(name)
  const room = (threadId: string) => P().room(harnessThreadRoom(threadId))

  const sinks = new Map<string, CollectionsTreeSink>()
  const projectors = new Map<string, Projector>()
  const sinkFor = (threadId: string): CollectionsTreeSink => {
    let s = sinks.get(threadId)
    if (!s) {
      s = collectionsTreeSink({
        collections: (n) => col(n),
        threadId,
        nodes: HARNESS_NODES,
        tools: HARNESS_TOOLS,
        threads: HARNESS_THREADS,
      })
      sinks.set(threadId, s)
    }
    return s
  }
  const projectorFor = (threadId: string): Projector => {
    let p = projectors.get(threadId)
    if (!p) {
      p = new Projector(sinkFor(threadId))
      projectors.set(threadId, p)
    }
    return p
  }

  // RLS helpers.
  const joined = async (principal: string): Promise<string[]> => {
    const rows = (await col(HARNESS_MEMBERSHIP).snapshot({ filter: eq('userId', principal) })) as MembershipRow[]
    return rows.map((r) => r.threadId)
  }
  const roleOf = async (threadId: string, userId: string): Promise<MemberRole | undefined> => {
    const row = (await col(HARNESS_MEMBERSHIP).read(membershipId(threadId, userId))) as MembershipRow | undefined
    return row?.role
  }
  const requireDriver = async (threadId: string, ctx: HarnessCtx): Promise<void> => {
    if ((await roleOf(threadId, ctx.userId)) === 'viewer') {
      throw new SuperLineError('FORBIDDEN', 'viewer role cannot drive the thread')
    }
  }

  const ok = { ok: true }
  const attempt = async (fn: () => Promise<unknown> | unknown): Promise<{ ok: boolean }> => {
    try {
      await fn()
      return ok
    } catch (e) {
      console.error('[harness] request failed', e)
      return { ok: false }
    }
  }

  const purgeThread = async (threadId: string): Promise<void> => {
    projectors.delete(threadId)
    sinks.delete(threadId)
    for (const c of [HARNESS_NODES, HARNESS_TOOLS, HARNESS_MEMBERSHIP]) {
      const rows = (await col(c).snapshot({ filter: eq('threadId', threadId) }).catch(() => [])) as { id: string }[]
      for (const r of rows) await col(c).delete(r.id).catch(() => {})
    }
    await col(HARNESS_THREADS).delete(threadId).catch(() => {})
  }

  const onBus = (threadId: string, e: BusEvent): void => {
    switch (e.type) {
      case 'reasoning_delta':
        room(threadId).broadcast('harness.reasoningDelta', { threadId, nodeId: e.nodeId, text: e.text })
        projectorFor(threadId).emit(e as never)
        return
      case 'text_delta':
        room(threadId).broadcast('harness.textDelta', { threadId, nodeId: e.nodeId, text: e.text })
        projectorFor(threadId).emit(e as never)
        return
      case 'tool_input_delta':
        room(threadId).broadcast('harness.toolInputDelta', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          argsTextDelta: e.argsTextDelta,
        })
        projectorFor(threadId).emit(e as never)
        return
      case 'suspended':
        room(threadId).broadcast('harness.suspended', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          request: e.request,
          resumeSchema: e.resumeSchema,
        })
        if (e.nodeId && e.toolCallId) sinkFor(threadId).setPending(e.nodeId, e.toolCallId, { resumeSchema: e.resumeSchema, request: e.request })
        return
      case 'approval_required':
        room(threadId).broadcast('harness.approvalRequired', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        })
        return
      case 'mode_changed':
        room(threadId).broadcast('harness.modeChanged', { threadId, modeId: e.modeId, previousModeId: e.previousModeId })
        return
      case 'follow_up_queued':
        room(threadId).broadcast('harness.followUpQueued', { threadId, count: e.count })
        return
      case 'thread_created':
        sinkFor(threadId).setThreadMeta({ resourceId: e.resourceId, title: e.title, createdAt: now(), updatedAt: now() })
        return
      case 'thread_renamed':
        sinkFor(threadId).setThreadMeta({ title: e.title, updatedAt: now() })
        return
      case 'thread_deleted':
        void purgeThread(threadId)
        return
      case 'tree_changed':
        return
      default:
        // A structural node event (node_start/end, usage, tool_*, error, todo).
        projectorFor(threadId).emit(e as never)
    }
  }

  const buildHandlers = (ctx: PluginContext) => {
    pctx = ctx
    return {
      'harness.join': async ({ threadId }: { threadId: string }, connCtx: unknown, conn: Conn) => {
        const c = connCtx as HarnessCtx
        room(threadId).add(conn)
        const role = opts.roleFor?.(c) ?? opts.defaultRole ?? 'operator'
        const row: MembershipRow = { id: membershipId(threadId, c.userId), threadId, userId: c.userId, role, joinedAt: now() }
        await col(HARNESS_MEMBERSHIP)
          .insert(row)
          .catch((e: unknown) => {
            if ((e as { code?: string })?.code !== 'CONFLICT') console.error('[harness] membership insert failed', e)
          })
        return ok
      },
      'harness.sendMessage': async ({ threadId, message }: { threadId: string; message: string }, connCtx: unknown) => {
        await requireDriver(threadId, connCtx as HarnessCtx)
        void engine.sendMessage({ threadId, content: message }).catch((e) => console.error('[harness] run failed', e))
        return ok
      },
      'harness.resumeMessage': async (
        { threadId, toolCallId, resumeData }: { threadId: string; toolCallId?: string; resumeData?: unknown },
        connCtx: unknown,
      ) => {
        await requireDriver(threadId, connCtx as HarnessCtx)
        try {
          void engine.resume({ threadId, toolCallId, resumeData }).catch((e) => console.error('[harness] resume failed', e))
          return ok
        } catch (e) {
          console.error('[harness] resume rejected', e)
          return { ok: false }
        }
      },
      'harness.abort': async ({ threadId }: { threadId: string }, connCtx: unknown) => {
        await requireDriver(threadId, connCtx as HarnessCtx)
        engine.abort(threadId)
        return ok
      },
      'harness.respondToApproval': async (
        input: { threadId: string; toolCallId?: string; decision: ApprovalDecision; message?: string },
        connCtx: unknown,
      ) => {
        await requireDriver(input.threadId, connCtx as HarnessCtx)
        return attempt(() => engine.respondToApproval(input as never))
      },
      'harness.switchMode': async ({ threadId, modeId }: { threadId: string; modeId: string }, connCtx: unknown) => {
        await requireDriver(threadId, connCtx as HarnessCtx)
        return attempt(() => engine.switchMode(threadId, modeId))
      },
      'harness.listModes': async () => ({
        modes: engine.listModes().map((m) => ({ id: m.id, name: m.name, description: m.description })),
        defaultModeId: engine.defaultModeId,
      }),
      'harness.listThreads': async (_input: { resourceId?: string }, connCtx: unknown) => ({
        threads: await engine.threads.list((connCtx as HarnessCtx).resourceId),
      }),
      'harness.createThread': async (
        input: { threadId?: string; resourceId?: string; title?: string },
        connCtx: unknown,
      ) => ({
        threadId: (await engine.threads.create({ ...input, resourceId: (connCtx as HarnessCtx).resourceId ?? input.resourceId })).id,
      }),
      'harness.renameThread': async ({ threadId, title }: { threadId: string; title: string }, connCtx: unknown) => {
        await requireDriver(threadId, connCtx as HarnessCtx)
        return attempt(() => engine.threads.rename(threadId, title))
      },
      'harness.deleteThread': async ({ threadId }: { threadId: string }, connCtx: unknown) => {
        await requireDriver(threadId, connCtx as HarnessCtx)
        return attempt(() => engine.threads.delete(threadId))
      },
    }
  }

  return {
    name: 'harness',
    policies: {
      [HARNESS_MEMBERSHIP]: { read: (principal) => eq('userId', principal) },
      [HARNESS_NODES]: { read: async (principal) => isIn('threadId', await joined(principal)) },
      [HARNESS_TOOLS]: { read: async (principal) => isIn('threadId', await joined(principal)) },
      // Thread LIST = your resource's threads (sidebar) UNIONED with threads you
      // joined. Membership must never be masked by resourceId: a client-minted
      // thread (join + send, no createThread) has no resourceId on its row, and
      // an eq-only filter would hide the caller's OWN thread — empty turns.
      [HARNESS_THREADS]: {
        read: async (principal, ctx) => {
          const rid = (ctx as HarnessCtx)?.resourceId
          const mine = isIn('id', await joined(principal))
          return rid ? or(eq('resourceId', rid), mine) : mine
        },
      },
    },
    handlers: buildHandlers as never,
    setup: (ctx) => {
      pctx = ctx
      const unsub = engine.subscribe(onBus as never)
      return () => unsub()
    },
  }
}

function now(): number {
  return Date.now()
}
