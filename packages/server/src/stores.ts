// Async LWW ServerStore backends that share a database the app already owns —
// Mastra's Postgres pool (`storage.db`) or a `@libsql/client` instance also
// given to LibSQLStore. Semantics port `@super-line/store-sqlite`: whole-doc
// replace, CONFLICT on duplicate create, NOT_FOUND on writes to missing rows.
// Because the drivers are async while `ServerReplica` is sync, mutations ride a
// per-resource promise chain (ordered persistence) and listeners fire only
// AFTER the row is written — clients never see a delta that failed to persist.
// The bindings are typed against structural subsets of the drivers (the sink.ts
// trick), so this module imports neither `pg-promise` nor `@libsql/client`.

import { SuperLineError, removeAtPath } from '@super-line/core'
import type { AccessRules, ServerReplica, ServerStore, StoreChange } from '@super-line/core'

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface SqlOps {
  ready: Promise<void>
  get(id: string): Promise<{ data: unknown; access: AccessRules } | undefined>
  /** INSERT if absent; false when the id already exists. */
  insert(id: string, data: unknown, access: AccessRules): Promise<boolean>
  /** UPDATE data; false when the row is missing. */
  setData(id: string, data: unknown): Promise<boolean>
  /** UPDATE access; false when the row is missing. */
  setAccess(id: string, access: AccessRules): Promise<boolean>
  delete(id: string): Promise<void>
  ids(): Promise<string[]>
}

function lwwStore(ops: SqlOps): ServerStore {
  const listeners = new Set<(c: StoreChange) => void>()
  const chains = new Map<string, Promise<void>>()
  // Latest locally-known doc per id — backs the sync getSnapshot()/update() on
  // replicas (the SQL round-trip is async, ServerReplica's surface is not).
  // ponytail: grows with docs touched this process — same order as the
  // projector trees already held in RAM; evict on replica close if it matters.
  const cache = new Map<string, unknown>()

  const enqueue = (id: string, task: () => Promise<void>): Promise<void> => {
    const run = (chains.get(id) ?? Promise.resolve()).then(task, task)
    chains.set(
      id,
      run.then(
        () => {},
        () => {},
      ),
    )
    return run
  }

  // Runs INSIDE a chained task — never call from another enqueued task via
  // commit() or the chain deadlocks on itself.
  const persist = async (change: StoreChange): Promise<void> => {
    await ops.ready
    const ok = await ops.setData(change.id, change.update ?? null)
    if (!ok) throw new SuperLineError('NOT_FOUND', `No resource: ${change.id}`)
    cache.set(change.id, change.update ?? null)
    for (const cb of listeners) cb(change)
  }
  const commit = (change: StoreChange) => enqueue(change.id, () => persist(change))
  const logLost = (e: unknown) => console.error('[superline-store] write failed', e)

  return {
    clustering: 'relay',
    model: 'lww',
    async read(id) {
      await ops.ready
      const row = await ops.get(id)
      return row ? { id, accessRules: row.access, data: row.data } : undefined
    },
    async create(id, data, accessRules) {
      await ops.ready
      const ok = await ops.insert(id, data ?? null, accessRules)
      if (!ok) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
      cache.set(id, data ?? null)
    },
    apply(change) {
      return commit(change)
    },
    open(id, openOpts): ServerReplica {
      const origin = openOpts?.origin ?? 'server'
      // Seed the cache from the DB so update()/getSnapshot() have a base when
      // this process hasn't written the doc yet (server restart). Ordered
      // ahead of any replica write via the chain. Unlike the sqlite backend,
      // a missing resource surfaces on the first write, not at open().
      void enqueue(id, async () => {
        await ops.ready
        if (cache.has(id)) return
        const row = await ops.get(id)
        if (row && !cache.has(id)) cache.set(id, row.data)
      }).catch(() => {})
      const subs = new Set<() => void>()
      return {
        getSnapshot: () => cache.get(id),
        subscribe: (cb) => {
          const wrap = (c: StoreChange) => {
            if (c.id === id) cb()
          }
          listeners.add(wrap)
          const off = () => void listeners.delete(wrap)
          subs.add(off)
          return () => {
            off()
            subs.delete(off)
          }
        },
        set: (data) => void commit({ id, update: data, origin }).catch(logLost),
        update: (partial) =>
          void enqueue(id, async () => {
            const base = cache.get(id)
            const merged =
              typeof base === 'object' && base !== null ? { ...(base as object), ...(partial as object) } : partial
            await persist({ id, update: merged, origin })
          }).catch(logLost),
        delete: (path) =>
          void enqueue(id, () => persist({ id, update: removeAtPath(cache.get(id), path), origin })).catch(logLost),
        close: () => {
          for (const off of subs) off()
          subs.clear()
        },
      }
    },
    async setAccess(id, accessRules) {
      await ops.ready
      const ok = await ops.setAccess(id, accessRules)
      if (!ok) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    },
    delete(id) {
      return enqueue(id, async () => {
        await ops.ready
        await ops.delete(id)
        cache.delete(id)
      })
    },
    async list() {
      await ops.ready
      return ops.ids()
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

// ── libsql ────────────────────────────────────────────────────────────────────

/** The libsql bind-value subset we use (a subset of `@libsql/client`'s InValue, kept import-free). */
type SqlArg = string | number | bigint | boolean | Uint8Array | null
/** Structural subset of `@libsql/client`'s Client — pass the same instance you give `new LibSQLStore({ client })`. */
export interface LibsqlClientLike {
  execute(stmt: { sql: string; args: SqlArg[] }): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }>
}

export function libsqlStoreServer(opts: { client: LibsqlClientLike; table?: string }): ServerStore {
  const table = opts.table ?? 'resources'
  if (!TABLE_RE.test(table)) throw new Error(`Invalid table name: ${table}`)
  const q = (sql: string, args: SqlArg[] = []) => opts.client.execute({ sql, args })
  const ready = (async () => {
    // Mastra skips its local pragmas when the client is injected, so nobody
    // else sets these on a shared client; both are no-ops on remote libsql.
    await q('PRAGMA journal_mode = WAL').catch(() => {})
    await q('PRAGMA busy_timeout = 5000').catch(() => {})
    await q(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data TEXT NOT NULL, access TEXT NOT NULL)`)
  })()
  return lwwStore({
    ready,
    get: async (id) => {
      const { rows } = await q(`SELECT data, access FROM "${table}" WHERE id = ?`, [id])
      const row = rows[0]
      if (!row) return undefined
      return { data: JSON.parse(String(row.data)), access: JSON.parse(String(row.access)) as AccessRules }
    },
    insert: async (id, data, access) =>
      (
        await q(`INSERT OR IGNORE INTO "${table}" (id, data, access) VALUES (?, ?, ?)`, [
          id,
          JSON.stringify(data),
          JSON.stringify(access),
        ])
      ).rowsAffected > 0,
    setData: async (id, data) =>
      (await q(`UPDATE "${table}" SET data = ? WHERE id = ?`, [JSON.stringify(data), id])).rowsAffected > 0,
    setAccess: async (id, access) =>
      (await q(`UPDATE "${table}" SET access = ? WHERE id = ?`, [JSON.stringify(access), id])).rowsAffected > 0,
    delete: async (id) => {
      await q(`DELETE FROM "${table}" WHERE id = ?`, [id])
    },
    ids: async () => (await q(`SELECT id FROM "${table}"`)).rows.map((r) => String(r.id)),
  })
}

// ── postgres ──────────────────────────────────────────────────────────────────

/** Structural subset of pg-promise's DbClient — `PostgresStore`'s public `storage.db` satisfies it. */
export interface PgDbLike {
  any(query: string, values?: unknown[]): Promise<unknown[]>
  oneOrNone(query: string, values?: unknown[]): Promise<unknown>
}

export function pgStoreServer(opts: { db: PgDbLike; table?: string }): ServerStore {
  const table = opts.table ?? 'resources'
  if (!TABLE_RE.test(table)) throw new Error(`Invalid table name: ${table}`)
  const { db } = opts
  const ready = db
    .any(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT PRIMARY KEY, data JSONB NOT NULL, access JSONB NOT NULL)`)
    .then(() => {})
  return lwwStore({
    ready,
    get: async (id) => {
      const row = (await db.oneOrNone(`SELECT data, access FROM "${table}" WHERE id = $1`, [id])) as {
        data: unknown
        access: AccessRules
      } | null
      return row ?? undefined
    },
    insert: async (id, data, access) =>
      (await db.oneOrNone(
        `INSERT INTO "${table}" (id, data, access) VALUES ($1, $2::jsonb, $3::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, JSON.stringify(data), JSON.stringify(access)],
      )) !== null,
    setData: async (id, data) =>
      (await db.oneOrNone(`UPDATE "${table}" SET data = $1::jsonb WHERE id = $2 RETURNING id`, [
        JSON.stringify(data),
        id,
      ])) !== null,
    setAccess: async (id, access) =>
      (await db.oneOrNone(`UPDATE "${table}" SET access = $1::jsonb WHERE id = $2 RETURNING id`, [
        JSON.stringify(access),
        id,
      ])) !== null,
    delete: async (id) => {
      await db.any(`DELETE FROM "${table}" WHERE id = $1`, [id])
    },
    ids: async () => (await db.any(`SELECT id FROM "${table}"`)).map((r) => String((r as { id: string }).id)),
  })
}
