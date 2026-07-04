// The super-line binding, in two composable pieces plus a standalone host:
//
//   harnessStores(storage)     the `harness.node`/`harness.thread` Store
//                              backends — spread into a server's `stores`
//                              config BEFORE createSuperLineServer.
//   mountHarness(srv, harness) attach the harness to an EXISTING super-line
//                              server: subscribes the bus, folds raw node
//                              events through a Projector into the Store
//                              sinks, relays session signals to rooms, and
//                              returns the `harness.*` handlers for the host
//                              to spread into its implement() call.
//   serve(harness, config)     the standalone entry — builds a server from
//                              the harness-only contract and mounts the SAME
//                              two pieces.
//
// The tree rides per-node/thread Stores. Content signals (suspended /
// approval_required / mode_changed / follow_up_queued) go to the per-thread
// room; thread-list signals (threadCreated / threadRenamed / threadDeleted)
// go to the per-RESOURCE room so every one of a resource's tabs stays in
// sync. Contract requests map 1:1 onto Harness methods.

import type { ServerTransport, Adapter, ServerStore } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'
import {
  contract,
  HARNESS_NODE_STORE,
  HARNESS_THREAD_STORE,
  harnessResourceRoom,
  harnessThreadRoom,
  type ApprovalDecision,
  type ModeInfo,
  type ThreadInfo,
} from '@super-harness/shared'
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

// Durable per-node/thread Store backend. sqlite (default) owns its own file
// and needs better-sqlite3 built (`pnpm approve-builds`); memory is for
// tests/dev. libsql/postgres write superline_* tables into a database the
// app already owns — pass the same @libsql/client you give LibSQLStore, or
// PostgresStore's public `storage.db`. pglite is the multi-node choice:
// central Postgres + Electric-synced replicas (`@super-line/store-pglite`, an
// optional peer) — pass the Postgres URL your app uses and the Electric shape
// endpoint.
export type HarnessStorage =
  | { type: 'sqlite' | 'memory'; path?: string }
  | { type: 'libsql'; client: LibsqlClientLike }
  | { type: 'postgres'; db: PgDbLike }
  | { type: 'pglite'; pgUrl: string; electricUrl?: string }

// The two harness Store backends, keyed by namespace for a server's `stores`
// config: `stores: { ...await harnessStores(cfg), ...ownStores }`. Distinct
// tables per namespace — sharing one table would let a node id and a thread
// id collide and silently clobber each other's doc. Table names flatten the
// namespace dot (`harness_node`); the shared-db backends prefix `superline_`
// to sit safely beside the app's own tables.
export interface HarnessStoreMap {
  'harness.node': ServerStore
  'harness.thread': ServerStore
}

export async function harnessStores(storage: HarnessStorage = { type: 'sqlite' }): Promise<HarnessStoreMap> {
  const backend = async (ns: string): Promise<ServerStore> => {
    const table = ns.replace('.', '_')
    switch (storage.type) {
      case 'memory':
        return memoryStoreServer()
      case 'libsql':
        return libsqlStoreServer({ client: storage.client, table: `superline_${table}` })
      case 'postgres':
        return pgStoreServer({ db: storage.db, table: `superline_${table}` })
      case 'pglite': {
        // Self-clustering: central Postgres + per-node Electric-synced replica.
        // Optional peer — only loaded when selected. onChange fans from the
        // replica's live.changes, so an Electric shape (electricUrl) is needed
        // for live updates across nodes.
        const { pgliteStoreServer } = await import('@super-line/store-pglite')
        return (await pgliteStoreServer({
          pgUrl: storage.pgUrl,
          electricUrl: storage.electricUrl,
          table: `superline_${table}`,
        })) as never
      }
      default: {
        const { sqliteStoreServer } = await import('@super-line/store-sqlite')
        return sqliteStoreServer({ file: storage.path ?? './harness.db', table } as never)
      }
    }
  }
  return {
    [HARNESS_NODE_STORE]: await backend(HARNESS_NODE_STORE),
    [HARNESS_THREAD_STORE]: await backend(HARNESS_THREAD_STORE),
  }
}

// What every connection's ctx must carry for the harness handlers — the host's
// authenticate() shapes it. userId is the Store principal; resourceId (when
// present) opts the connection into server-authoritative thread scoping.
// REQUIRED alongside it: the host's `identify` must return ctx.userId — store
// ACL grants key on it, and super-line's principal falls back to the random
// conn.id otherwise, denying every tree read.
export interface HarnessCtx {
  userId: string
  resourceId?: string
}

// The `harness.*` request handlers, typed so a host can spread them into its
// implement() `shared` block without casts — provided every role's ctx
// extends HarnessCtx.
export interface HarnessHandlers {
  'harness.join'(input: { threadId: string }, ctx: HarnessCtx, conn: unknown): Promise<{ ok: boolean }>
  'harness.sendMessage'(input: { threadId: string; message: string }): Promise<{ ok: boolean }>
  'harness.resumeMessage'(input: { threadId: string; toolCallId?: string; resumeData?: unknown }): Promise<{ ok: boolean }>
  'harness.abort'(input: { threadId: string }): Promise<{ ok: boolean }>
  'harness.respondToApproval'(input: {
    threadId: string
    toolCallId?: string
    decision: ApprovalDecision
    message?: string
  }): Promise<{ ok: boolean }>
  'harness.switchMode'(input: { threadId: string; modeId: string }): Promise<{ ok: boolean }>
  'harness.listModes'(input: unknown): Promise<{ modes: ModeInfo[]; defaultModeId?: string }>
  'harness.listThreads'(input: { resourceId?: string }, ctx: HarnessCtx, conn: unknown): Promise<{ threads: ThreadInfo[] }>
  'harness.createThread'(
    input: { threadId?: string; resourceId?: string; title?: string },
    ctx: HarnessCtx,
    conn: unknown,
  ): Promise<{ threadId: string }>
  'harness.renameThread'(input: { threadId: string; title: string }, ctx: HarnessCtx, conn: unknown): Promise<{ ok: boolean }>
  'harness.deleteThread'(input: { threadId: string }, ctx: HarnessCtx, conn: unknown): Promise<{ ok: boolean }>
}

// Structural view of the host server — only what the harness touches, typed
// like sink.ts so ANY host's createSuperLineServer instance fits regardless
// of its own contract generics (params are `never`-typed: contravariance
// makes the real, narrower signatures assign cleanly).
export interface HarnessHost {
  room(name: string): { add(conn: never): void; broadcast(event: never, data: never): void }
  store(name: string): unknown
}

export interface HarnessMount {
  // Spread into the host's implement() `shared` block:
  //   srv.implement({ shared: { ...mount.handlers, ...ownShared }, user: {...} })
  handlers: HarnessHandlers
  // Detach the harness bus subscription (the server itself stays up).
  close(): void
}

interface RoomLike {
  add(conn: unknown): void
  broadcast(event: string, data: unknown): void
}

// Attach a Harness to an existing super-line server whose contract merges
// harnessSurface into `shared`, whose `stores` spread harnessStores(), whose
// authenticate() ctx extends HarnessCtx, and whose `identify` returns
// ctx.userId (see HarnessCtx). Call AFTER createSuperLineServer, BEFORE (or
// while composing) implement().
export function mountHarness(srv: HarnessHost, harness: Harness): HarnessMount {
  const room = (threadId: string) => srv.room(harnessThreadRoom(threadId)) as RoomLike
  const resourceRoom = (resourceId: string) => srv.room(harnessResourceRoom(resourceId)) as RoomLike
  const threadStoreOf = () => srv.store(HARNESS_THREAD_STORE)
  const nodeStoreOf = () => srv.store(HARNESS_NODE_STORE)

  // Thread scoping is OPT-IN: a connection with a `resourceId` in ctx gets a
  // scoped, server-authoritative thread list; one without keeps list-all. The
  // resource-room key always resolves (falls back to userId) so every
  // connection lands in some room.
  const resourceOf = (ctx: HarnessCtx) => ctx.resourceId ?? ctx.userId
  // Rooms have no connect-time hook a library can reach, so membership is
  // joined lazily in the handlers every real client flow passes through
  // (join / listThreads / createThread). Rooms auto-remove on disconnect.
  const joinResourceRoom = (ctx: HarnessCtx, conn: unknown) => resourceRoom(resourceOf(ctx)).add(conn)

  const threadPrincipals = new Map<string, Set<string>>()
  const projectors = new Map<string, Projector>()
  const projectorFor = (threadId: string): Projector => {
    let p = projectors.get(threadId)
    if (!p) {
      p = new Projector(
        superlineTreeSink({
          nodeStore: nodeStoreOf() as never,
          threadStore: threadStoreOf() as never,
          threadId,
          grantTo: () => [...(threadPrincipals.get(threadId) ?? new Set())],
        }),
      )
      projectors.set(threadId, p)
    }
    return p
  }

  const unsubscribe = harness.subscribe((threadId, e) => {
    if (!SESSION_EVENTS.has(e.type)) {
      // A raw node event: mirror it into the durable Stores via the fold.
      projectorFor(threadId).emit(e as HarnessEvent)
      return
    }
    switch (e.type) {
      case 'suspended':
        room(threadId).broadcast('harness.suspended', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          request: e.request,
          resumeSchema: e.resumeSchema,
        })
        break
      case 'approval_required':
        room(threadId).broadcast('harness.approvalRequired', {
          threadId,
          nodeId: e.nodeId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        })
        break
      case 'mode_changed':
        room(threadId).broadcast('harness.modeChanged', { threadId, modeId: e.modeId, previousModeId: e.previousModeId })
        break
      case 'follow_up_queued':
        room(threadId).broadcast('harness.followUpQueued', { threadId, count: e.count })
        break
      // Thread-list events go to the RESOURCE room (all the resource's tabs),
      // not the per-thread room — a tab viewing another thread must still see
      // its sidebar change.
      case 'thread_created':
        resourceRoom(e.resourceId).broadcast('harness.threadCreated', { id: threadId, resourceId: e.resourceId, title: e.title })
        break
      case 'thread_renamed':
        resourceRoom(e.resourceId).broadcast('harness.threadRenamed', { threadId, title: e.title })
        break
      case 'thread_deleted': {
        resourceRoom(e.resourceId).broadcast('harness.threadDeleted', { threadId })
        // Drop server-side caches so a reused thread id starts clean.
        projectors.delete(threadId)
        threadPrincipals.delete(threadId)
        // Purge the durable tree docs too — otherwise they outlive the thread
        // forever, and a reused threadId resurrects the deleted conversation
        // via the sink's restart-merge base.
        const threadStore = threadStoreOf() as {
          read?(id: string): Promise<{ data?: { nodes?: Record<string, unknown> } } | undefined>
          delete(id: string): Promise<void>
        }
        const nodeStore = nodeStoreOf() as { delete(id: string): Promise<void> }
        void (async () => {
          const doc = await threadStore.read?.(threadId).catch(() => undefined)
          for (const nodeId of Object.keys(doc?.data?.nodes ?? {})) await nodeStore.delete(nodeId).catch(() => {})
          await threadStore.delete(threadId).catch(() => {})
        })()
        break
      }
      // tree_changed has no wire form: the tree itself rides the Stores.
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

  const handlers: HarnessHandlers = {
    'harness.join': async ({ threadId }, ctx, conn) => {
      room(threadId).add(conn)
      joinResourceRoom(ctx, conn)
      const set = threadPrincipals.get(threadId) ?? new Set<string>()
      set.add(ctx.userId)
      threadPrincipals.set(threadId, set)
      // Pre-create the thread Resource granted to this connection — a client
      // open() on a not-yet-existent Resource is a dead handle, so it must exist
      // (and be readable) before the client subscribes.
      const store = threadStoreOf() as {
        create(id: string, data: unknown, rules: unknown): Promise<void>
        grant?(id: string, principal: string, perms: unknown): Promise<void>
        read?(id: string): Promise<{ data?: { nodes?: Record<string, unknown> } } | undefined>
      }
      await store.create(threadId, { turns: [], nodes: {} }, { [ctx.userId]: { read: true } }).catch(() => {})
      await store.grant?.(threadId, ctx.userId, { read: true }).catch(() => {})
      // Late joiner: node Resources created before this join carry the old
      // grants — grant every node listed in the durable thread doc.
      const nodeStore = nodeStoreOf() as {
        grant?(id: string, principal: string, perms: unknown): Promise<void>
      }
      const doc = await store.read?.(threadId).catch(() => undefined)
      for (const nodeId of Object.keys(doc?.data?.nodes ?? {})) {
        await nodeStore.grant?.(nodeId, ctx.userId, { read: true }).catch(() => {})
      }
      return ok
    },
    'harness.sendMessage': async ({ threadId, message }) => {
      void harness.sendMessage({ threadId, content: message }).catch((e) => console.error('[harness] run failed', e))
      return ok
    },
    'harness.resumeMessage': async ({ threadId, toolCallId, resumeData }) => {
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
    'harness.abort': async ({ threadId }) => {
      harness.abort(threadId)
      return ok
    },
    'harness.respondToApproval': async (input) => attempt(() => harness.respondToApproval(input as never)),
    'harness.switchMode': async ({ threadId, modeId }) => attempt(() => harness.switchMode(threadId, modeId)),
    'harness.listModes': async () => ({
      modes: harness.listModes().map((m) => ({ id: m.id, name: m.name, description: m.description })),
      defaultModeId: harness.defaultModeId,
    }),
    // When the connection carries a resourceId, the list is scoped to it and
    // creates are pinned to it (server-authoritative — the client can't list
    // or plant threads under another resource). Without one, ctx.resourceId is
    // undefined: list-all and the harness's own resourceId default apply.
    'harness.listThreads': async (_input, ctx, conn) => {
      joinResourceRoom(ctx, conn)
      return { threads: await harness.threads.list(ctx.resourceId) }
    },
    'harness.createThread': async (input, ctx, conn) => {
      joinResourceRoom(ctx, conn)
      return { threadId: (await harness.threads.create({ ...input, resourceId: ctx.resourceId ?? input.resourceId })).id }
    },
    // Rename/delete also join lazily: their echoes (threadRenamed/threadDeleted)
    // broadcast to the resource room, and the caller must hear its own echo.
    'harness.renameThread': async ({ threadId, title }, ctx, conn) => {
      joinResourceRoom(ctx, conn)
      return attempt(() => harness.threads.rename(threadId, title))
    },
    'harness.deleteThread': async ({ threadId }, ctx, conn) => {
      joinResourceRoom(ctx, conn)
      return attempt(() => harness.threads.delete(threadId))
    },
  }

  return { handlers, close: unsubscribe }
}

export interface ServeConfig {
  storage?: HarnessStorage
  transports?: ServerTransport[]
  adapter?: Adapter
  authenticate?: (handshake: unknown) => { role: 'user'; ctx: HarnessCtx }
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

// The standalone host: the harness-only contract on its own super-line server.
export async function serve(harness: Harness, config: ServeConfig = {}): Promise<HarnessServer> {
  const server = createSuperLineServer(contract, {
    transports: config.transports ?? [],
    authenticate:
      config.authenticate ??
      ((h: unknown) => {
        const q = (h as { query?: Record<string, string> })?.query ?? {}
        // resourceId stays undefined when absent → list-all (backward compat);
        // userId falls back to it, then 'local', for the store principal.
        return { role: 'user' as const, ctx: { userId: q.userId ?? q.resourceId ?? 'local', resourceId: q.resourceId } }
      }),
    identify: (conn: { ctx: { userId: string } }) => conn.ctx.userId,
    stores: await harnessStores(config.storage),
    inspector: config.inspector ?? false,
    adapter: config.adapter,
  } as never)

  const { handlers, close } = mountHarness(server as unknown as HarnessHost, harness)
  server.implement({ shared: handlers, user: {} } as never)

  return { server, close }
}
