// Async LWW ServerStore backends that share a database the app already owns —
// Mastra's Postgres pool (`storage.db`) or a `@libsql/client` instance also
// given to LibSQLStore. Semantics port `@super-line/store-sqlite`: whole-doc
// replace, CONFLICT on duplicate create, NOT_FOUND on writes to missing rows,
// `created_at`/`updated_at` timestamps, and filtered list(opts)/searchPrincipals.
// Because the drivers are async while `ServerReplica` is sync, mutations ride a
// per-resource promise chain (ordered persistence) and listeners fire only
// AFTER the row is written — clients never see a delta that failed to persist.
// The bindings are typed against structural subsets of the drivers (the sink.ts
// trick), so this module imports neither `pg-promise` nor `@libsql/client`.

import { SuperLineError, removeAtPath } from '@super-line/core'
import type {
  AccessRules,
  ListOpts,
  ResourceSummary,
  SearchOpts,
  ServerReplica,
  ServerStore,
  StoreChange,
} from '@super-line/core'

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// DB-clock epoch-ms expressions, inlined into writes so timestamps use the
// store's clock (no trigger). ponytail: parity with store-sqlite's NOW_MS.
const SQLITE_NOW = "unixepoch('subsec') * 1000"
const PG_NOW = '(extract(epoch from clock_timestamp()) * 1000)::bigint'

// Sort keys → the SQL the dialect orders by. `principalCount` has no column:
// both order by the select-list alias (sqlite bare, pg quoted-and-preserved).
type SortBy = NonNullable<ListOpts['sort']>['by']
const SORT_COL_SQLITE: Record<SortBy, string> = {
  id: 'id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  principalCount: 'principalCount',
}
const SORT_COL_PG: Record<SortBy, string> = {
  id: 'id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  principalCount: '"principalCount"',
}

interface SqlOps {
  ready: Promise<void>
  get(id: string): Promise<{ data: unknown; access: AccessRules } | undefined>
  /** INSERT if absent; false when the id already exists. */
  insert(id: string, data: unknown, access: AccessRules): Promise<boolean>
  /** UPDATE data (+ bump updated_at); false when the row is missing. */
  setData(id: string, data: unknown): Promise<boolean>
  /** UPDATE access (+ bump updated_at); false when the row is missing. */
  setAccess(id: string, access: AccessRules): Promise<boolean>
  delete(id: string): Promise<void>
  /** Filtered / sorted / paginated Resource summaries (principals derived from the access JSON). */
  list(opts?: ListOpts): Promise<ResourceSummary[]>
  /** Distinct principals across every access rule, substring-filtered + paginated. */
  searchPrincipals(opts: SearchOpts): Promise<string[]>
}

function summaryRow(r: Record<string, unknown>): ResourceSummary {
  return {
    id: String(r.id),
    principalCount: Number(r.principalCount),
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  }
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
    async list(opts) {
      await ops.ready
      return ops.list(opts)
    },
    async searchPrincipals(opts) {
      await ops.ready
      return ops.searchPrincipals(opts)
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
    await q(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         id TEXT PRIMARY KEY, data TEXT NOT NULL, access TEXT NOT NULL,
         created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW}),
         updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW}))`,
    )
    // Legacy tables predate the timestamp columns. sqlite forbids a volatile
    // DEFAULT on ADD COLUMN, so add nullable then backfill existing rows.
    const cols = new Set((await q(`PRAGMA table_info("${table}")`)).rows.map((r) => String(r.name)))
    if (!cols.has('created_at')) await q(`ALTER TABLE "${table}" ADD COLUMN created_at INTEGER`)
    if (!cols.has('updated_at')) await q(`ALTER TABLE "${table}" ADD COLUMN updated_at INTEGER`)
    await q(`UPDATE "${table}" SET created_at = ${SQLITE_NOW} WHERE created_at IS NULL`)
    await q(`UPDATE "${table}" SET updated_at = ${SQLITE_NOW} WHERE updated_at IS NULL`)
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
        await q(
          `INSERT OR IGNORE INTO "${table}" (id, data, access, created_at, updated_at) VALUES (?, ?, ?, ${SQLITE_NOW}, ${SQLITE_NOW})`,
          [id, JSON.stringify(data), JSON.stringify(access)],
        )
      ).rowsAffected > 0,
    setData: async (id, data) =>
      (await q(`UPDATE "${table}" SET data = ?, updated_at = ${SQLITE_NOW} WHERE id = ?`, [JSON.stringify(data), id]))
        .rowsAffected > 0,
    setAccess: async (id, access) =>
      (await q(`UPDATE "${table}" SET access = ?, updated_at = ${SQLITE_NOW} WHERE id = ?`, [JSON.stringify(access), id]))
        .rowsAffected > 0,
    delete: async (id) => {
      await q(`DELETE FROM "${table}" WHERE id = ?`, [id])
    },
    list: async (opts) => {
      const { idContains, principals, sort, limit, offset = 0 } = opts ?? {}
      const where: string[] = []
      const args: SqlArg[] = []
      if (idContains !== undefined) {
        where.push('instr(id, ?) > 0') // literal substring (matches JS .includes), not LIKE's wildcards
        args.push(idContains)
      }
      if (principals?.length) {
        where.push(
          `id IN (SELECT t2.id FROM "${table}" t2, json_each(t2.access) je WHERE je.key IN (${principals.map(() => '?').join(',')}))`,
        )
        args.push(...principals)
      }
      const by = SORT_COL_SQLITE[sort?.by ?? 'id']
      const dir = sort?.dir === 'desc' ? 'DESC' : 'ASC'
      const sql =
        `SELECT id, (SELECT count(*) FROM json_each("${table}".access)) AS principalCount,` +
        ` created_at AS createdAt, updated_at AS updatedAt FROM "${table}"` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${by} ${dir}${by === 'id' ? '' : ', id ASC'} LIMIT ? OFFSET ?`
      args.push(limit ?? -1, offset) // sqlite LIMIT -1 = unbounded
      return (await q(sql, args)).rows.map(summaryRow)
    },
    searchPrincipals: async ({ query, limit, offset = 0 }) => {
      const sql =
        `SELECT DISTINCT je.key AS principal FROM "${table}", json_each("${table}".access) je` +
        (query !== undefined ? ' WHERE instr(je.key, ?) > 0' : '') +
        ' ORDER BY principal ASC LIMIT ? OFFSET ?'
      const args: SqlArg[] = query !== undefined ? [query, limit ?? -1, offset] : [limit ?? -1, offset]
      return (await q(sql, args)).rows.map((r) => String(r.principal))
    },
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
  const ready = (async () => {
    await db.any(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         id TEXT PRIMARY KEY, data JSONB NOT NULL, access JSONB NOT NULL,
         created_at BIGINT NOT NULL DEFAULT (${PG_NOW}),
         updated_at BIGINT NOT NULL DEFAULT (${PG_NOW}))`,
    )
    // Legacy tables predate the timestamp columns: add + backfill (idempotent).
    await db.any(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS created_at BIGINT`)
    await db.any(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS updated_at BIGINT`)
    await db.any(`UPDATE "${table}" SET created_at = ${PG_NOW} WHERE created_at IS NULL`)
    await db.any(`UPDATE "${table}" SET updated_at = ${PG_NOW} WHERE updated_at IS NULL`)
  })()
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
        `INSERT INTO "${table}" (id, data, access, created_at, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, ${PG_NOW}, ${PG_NOW}) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, JSON.stringify(data), JSON.stringify(access)],
      )) !== null,
    setData: async (id, data) =>
      (await db.oneOrNone(`UPDATE "${table}" SET data = $1::jsonb, updated_at = ${PG_NOW} WHERE id = $2 RETURNING id`, [
        JSON.stringify(data),
        id,
      ])) !== null,
    setAccess: async (id, access) =>
      (await db.oneOrNone(`UPDATE "${table}" SET access = $1::jsonb, updated_at = ${PG_NOW} WHERE id = $2 RETURNING id`, [
        JSON.stringify(access),
        id,
      ])) !== null,
    delete: async (id) => {
      await db.any(`DELETE FROM "${table}" WHERE id = $1`, [id])
    },
    list: async (opts) => {
      const { idContains, principals, sort, limit, offset = 0 } = opts ?? {}
      const where: string[] = []
      const args: unknown[] = []
      let i = 1
      if (idContains !== undefined) {
        where.push(`strpos(id, $${i++}) > 0`)
        args.push(idContains)
      }
      if (principals?.length) {
        const ph = principals.map(() => `$${i++}`).join(',')
        where.push(`id IN (SELECT t2.id FROM "${table}" t2, jsonb_object_keys(t2.access) AS pk(principal) WHERE pk.principal IN (${ph}))`)
        args.push(...principals)
      }
      const by = SORT_COL_PG[sort?.by ?? 'id']
      const dir = sort?.dir === 'desc' ? 'DESC' : 'ASC'
      const limitClause = limit === undefined ? 'LIMIT ALL' : `LIMIT $${i++}`
      if (limit !== undefined) args.push(limit)
      const offsetClause = `OFFSET $${i++}`
      args.push(offset)
      const sql =
        `SELECT id, (SELECT count(*)::int FROM jsonb_object_keys("${table}".access)) AS "principalCount",` +
        ` created_at AS "createdAt", updated_at AS "updatedAt" FROM "${table}"` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${by} ${dir}${by === 'id' ? '' : ', id ASC'} ${limitClause} ${offsetClause}`
      return (await db.any(sql, args)).map((r) => summaryRow(r as Record<string, unknown>))
    },
    searchPrincipals: async ({ query, limit, offset = 0 }) => {
      const args: unknown[] = []
      let i = 1
      let sql = `SELECT DISTINCT principal FROM "${table}", jsonb_object_keys(access) AS pk(principal)`
      if (query !== undefined) {
        sql += ` WHERE strpos(principal, $${i++}) > 0`
        args.push(query)
      }
      const limitClause = limit === undefined ? 'LIMIT ALL' : `LIMIT $${i++}`
      if (limit !== undefined) args.push(limit)
      sql += ` ORDER BY principal ASC ${limitClause} OFFSET $${i++}`
      args.push(offset)
      return (await db.any(sql, args)).map((r) => String((r as { principal: string }).principal))
    },
  })
}
