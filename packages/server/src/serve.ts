// The super-line binding: serve(harness, config) exposes an existing (transport-
// free) Harness over super-line. The tree rides per-node/thread Stores — this
// module subscribes to the harness bus, folds raw node events through its own
// Projector into Store-backed sinks, and relays the ephemeral session signals
// (suspended / approval_required / mode_changed / follow_up_queued /
// thread_renamed) to the thread's room. Contract requests map 1:1 onto
// Harness methods.

import type { ServerTransport } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'
import { contract } from '@super-harness/shared'
import { Projector, type Harness, type HarnessEvent } from '@super-harness/core'
import { superlineTreeSink } from './sink'
import { libsqlStoreServer, pgStoreServer, type LibsqlClientLike, type PgDbLike } from './stores'

const SESSION_EVENTS = new Set([
  'suspended',
  'approval_required',
  'follow_up_queued',
  'mode_changed',
  'thread_created',
  'thread_renamed',
  'thread_deleted',
  'tree_changed',
])

export interface ServeConfig {
  // Durable per-node/thread Store backend. sqlite (default) owns its own file
  // and needs better-sqlite3 built (`pnpm approve-builds`); memory is for
  // tests/dev. libsql/postgres write superline_* tables into a database the
  // app already owns — pass the same @libsql/client you give LibSQLStore, or
  // PostgresStore's public `storage.db`.
  storage?:
    | { type: 'sqlite' | 'memory'; path?: string }
    | { type: 'libsql'; client: LibsqlClientLike }
    | { type: 'postgres'; db: PgDbLike }
  transports?: ServerTransport[]
  authenticate?: (handshake: unknown) => { role: 'user'; ctx: { userId: string } }
  // Control Center inspector (read-only, UNAUTHENTICATED — dev/trusted only).
  // The WS transport must ALSO be created with `inspector: true` to negotiate
  // the `superline.inspector.v1` subprotocol.
  inspector?: boolean | { redact?: string[] }
}

export interface HarnessServer {
  server: ReturnType<typeof createSuperLineServer>
  // Detach the bus subscription (the super-line server itself is torn down by
  // closing its transports/http server).
  close(): void
}

export async function serve(harness: Harness, config: ServeConfig = {}): Promise<HarnessServer> {
  // Distinct tables per namespace — sharing one table would let a node id and
  // a thread id collide and silently clobber each other's doc. The shared-db
  // backends prefix with superline_ to sit safely beside the app's own tables.
  const backend = async (ns: string) => {
    const storage = config.storage ?? { type: 'sqlite' as const }
    switch (storage.type) {
      case 'memory':
        return memoryStoreServer()
      case 'libsql':
        return libsqlStoreServer({ client: storage.client, table: `superline_${ns}` })
      case 'postgres':
        return pgStoreServer({ db: storage.db, table: `superline_${ns}` })
      default: {
        const { sqliteStoreServer } = await import('@super-line/store-sqlite')
        return sqliteStoreServer({ file: storage.path ?? './harness.db', table: ns } as never)
      }
    }
  }

  const server = createSuperLineServer(contract, {
    transports: config.transports ?? [],
    authenticate:
      config.authenticate ??
      ((h: unknown) => ({ role: 'user' as const, ctx: { userId: (h as any)?.query?.userId ?? 'local' } })),
    identify: (conn: { ctx: { userId: string } }) => conn.ctx.userId,
    stores: { node: await backend('node'), thread: await backend('thread') },
    inspector: config.inspector ?? false,
  } as never)

  const threadPrincipals = new Map<string, Set<string>>()
  const projectors = new Map<string, Projector>()
  const projectorFor = (threadId: string): Projector => {
    let p = projectors.get(threadId)
    if (!p) {
      p = new Projector(
        superlineTreeSink({
          nodeStore: server.store('node') as never,
          threadStore: server.store('thread') as never,
          threadId,
          grantTo: () => [...(threadPrincipals.get(threadId) ?? new Set())],
        }),
      )
      projectors.set(threadId, p)
    }
    return p
  }

  const room = (threadId: string) => server.room(`thread:${threadId}`)

  const unsubscribe = harness.subscribe((threadId, e) => {
    if (!SESSION_EVENTS.has(e.type)) {
      // A raw node event: mirror it into the durable Stores via the fold.
      projectorFor(threadId).emit(e as HarnessEvent)
      return
    }
    switch (e.type) {
      case 'suspended':
        room(threadId).broadcast('suspended', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          request: e.request,
          resumeSchema: e.resumeSchema,
        })
        break
      case 'approval_required':
        room(threadId).broadcast('approvalRequired', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        })
        break
      case 'mode_changed':
        room(threadId).broadcast('modeChanged', { threadId, modeId: e.modeId, previousModeId: e.previousModeId })
        break
      case 'follow_up_queued':
        room(threadId).broadcast('followUpQueued', { threadId, count: e.count })
        break
      case 'thread_renamed':
        room(threadId).broadcast('threadRenamed', { threadId, title: e.title })
        break
      case 'thread_deleted': {
        // Drop server-side caches so a reused thread id starts clean.
        projectors.delete(threadId)
        threadPrincipals.delete(threadId)
        // Purge the durable tree docs too — otherwise they outlive the thread
        // forever, and a reused threadId resurrects the deleted conversation
        // via the sink's restart-merge base.
        const threadStore = server.store('thread') as unknown as {
          read?(id: string): Promise<{ data?: { nodes?: Record<string, unknown> } } | undefined>
          delete(id: string): Promise<void>
        }
        const nodeStore = server.store('node') as unknown as { delete(id: string): Promise<void> }
        void (async () => {
          const doc = await threadStore.read?.(threadId).catch(() => undefined)
          for (const nodeId of Object.keys(doc?.data?.nodes ?? {})) await nodeStore.delete(nodeId).catch(() => {})
          await threadStore.delete(threadId).catch(() => {})
        })()
        break
      }
      // thread_created/tree_changed have no wire form: thread creation is
      // request/response, and the tree itself rides the Stores.
    }
  })

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

  server.implement({
    shared: {
      join: async ({ threadId }: { threadId: string }, ctx: { userId: string }, conn: unknown) => {
        room(threadId).add(conn as never)
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
        // Late joiner: node Resources created before this join carry the old
        // grants — grant every node listed in the durable thread doc.
        const threadStore = server.store('thread') as unknown as {
          read?(id: string): Promise<{ data?: { nodes?: Record<string, unknown> } } | undefined>
        }
        const nodeStore = server.store('node') as unknown as {
          grant?(id: string, principal: string, perms: unknown): Promise<void>
        }
        const doc = await threadStore.read?.(threadId).catch(() => undefined)
        for (const nodeId of Object.keys(doc?.data?.nodes ?? {})) {
          await nodeStore.grant?.(nodeId, ctx.userId, { read: true }).catch(() => {})
        }
        return ok
      },
      sendMessage: async ({ threadId, message }: { threadId: string; message: string }) => {
        void harness.sendMessage({ threadId, content: message }).catch((e) => console.error('[harness] run failed', e))
        return ok
      },
      resumeMessage: async ({ threadId, toolCallId, resumeData }: { threadId: string; toolCallId?: string; resumeData: unknown }) => {
        // resume() validates synchronously (unknown/ambiguous toolCallId,
        // mid-turn thread) and throws before the turn starts; the turn itself
        // is fire-and-forget like sendMessage.
        try {
          void harness.resume({ threadId, toolCallId, resumeData }).catch((e) => console.error('[harness] resume failed', e))
          return ok
        } catch (e) {
          console.error('[harness] resume rejected', e)
          return { ok: false }
        }
      },
      abort: async ({ threadId }: { threadId: string }) => {
        harness.abort(threadId)
        return ok
      },
      respondToApproval: async (input: { threadId: string; toolCallId?: string; decision: never; message?: string }) =>
        attempt(() => harness.respondToApproval(input)),
      switchMode: async ({ threadId, modeId }: { threadId: string; modeId: string }) =>
        attempt(() => harness.switchMode(threadId, modeId)),
      listModes: async () => ({
        modes: harness.listModes().map((m) => ({ id: m.id, name: m.name, description: m.description })),
        defaultModeId: harness.defaultModeId,
      }),
      listThreads: async ({ resourceId }: { resourceId?: string }) => ({
        threads: await harness.threads.list(resourceId),
      }),
      createThread: async (input: { threadId?: string; resourceId?: string; title?: string }) => ({
        threadId: (await harness.threads.create(input)).id,
      }),
      renameThread: async ({ threadId, title }: { threadId: string; title: string }) =>
        attempt(() => harness.threads.rename(threadId, title)),
      deleteThread: async ({ threadId }: { threadId: string }) => attempt(() => harness.threads.delete(threadId)),
    },
    user: {},
  } as never)

  return { server, close: unsubscribe }
}
