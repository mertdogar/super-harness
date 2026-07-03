// Both backends run the same suite against a REAL database — @libsql/client
// in-memory and PGlite (real Postgres semantics, in-process) — because the
// entire risk surface of these ~200 lines is SQL dialect, not logic.

import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { PGlite } from '@electric-sql/pglite'
import type { ServerStore, StoreChange } from '@super-line/core'
import { libsqlStoreServer, pgStoreServer, type PgDbLike } from './stores'

const pglite = new PGlite()
const pgDb: PgDbLike = {
  any: async (query, values) => (await pglite.query(query, values as never[])).rows,
  oneOrNone: async (query, values) => (await pglite.query(query, values as never[])).rows[0] ?? null,
}

let n = 0
interface Backend {
  name: string
  make(): { store: ServerStore; reopen(): ServerStore }
}
const backends: Backend[] = [
  {
    name: 'libsql',
    make: () => {
      const client = createClient({ url: ':memory:' })
      const table = `superline_t${n++}`
      return { store: libsqlStoreServer({ client, table }), reopen: () => libsqlStoreServer({ client, table }) }
    },
  },
  {
    name: 'postgres',
    make: () => {
      const table = `superline_t${n++}`
      return { store: pgStoreServer({ db: pgDb, table }), reopen: () => pgStoreServer({ db: pgDb, table }) }
    },
  },
]

const nextChange = (store: ServerStore, act: () => void): Promise<StoreChange> =>
  new Promise((resolve) => {
    const off = store.onChange((c) => {
      off()
      resolve(c)
    })
    act()
  })

for (const { name, make } of backends) {
  describe(`${name}StoreServer`, () => {
    it('create → read roundtrip with access rules', async () => {
      const { store } = make()
      await store.create('a', { v: 1 }, { alice: { read: true, write: false } })
      const res = await store.read('a')
      expect(res).toEqual({ id: 'a', data: { v: 1 }, accessRules: { alice: { read: true, write: false } } })
      expect(await store.read('missing')).toBeUndefined()
    })

    it('duplicate create rejects with CONFLICT', async () => {
      const { store } = make()
      await store.create('a', 1, {})
      await expect(async () => store.create('a', 2, {})).rejects.toMatchObject({ code: 'CONFLICT' })
      expect((await store.read('a'))?.data).toBe(1)
    })

    it('apply replaces the doc and fires onChange after persistence', async () => {
      const { store } = make()
      await store.create('a', { v: 1 }, {})
      const seen: StoreChange[] = []
      store.onChange((c) => seen.push(c))
      await store.apply({ id: 'a', update: { v: 2 }, origin: 'client-x' })
      expect(seen).toEqual([{ id: 'a', update: { v: 2 }, origin: 'client-x' }])
      expect((await store.read('a'))?.data).toEqual({ v: 2 })
    })

    it('apply to a missing resource rejects NOT_FOUND', async () => {
      const { store } = make()
      await expect(async () => store.apply({ id: 'nope', update: 1, origin: 'x' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    })

    it('setAccess replaces rules; missing resource rejects NOT_FOUND', async () => {
      const { store } = make()
      await store.create('a', 1, { alice: { read: true, write: false } })
      await store.setAccess('a', { bob: { read: true, write: true } })
      expect((await store.read('a'))?.accessRules).toEqual({ bob: { read: true, write: true } })
      await expect(async () => store.setAccess('nope', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('delete removes the doc; list reflects it', async () => {
      const { store } = make()
      await store.create('a', 1, {})
      await store.create('b', 2, {})
      expect((await store.list()).sort()).toEqual(['a', 'b'])
      await store.delete('a')
      expect(await store.read('a')).toBeUndefined()
      expect(await store.list()).toEqual(['b'])
      await store.delete('missing') // no throw, mirrors store-sqlite
    })

    it('replica set() persists in call order — last write wins', async () => {
      const { store } = make()
      await store.create('a', 0, {})
      const replica = store.open!('a')
      const done = new Promise<void>((resolve) => {
        store.onChange((c) => {
          if (c.update === 3) resolve()
        })
      })
      replica.set(1)
      replica.set(2)
      replica.set(3)
      await done
      expect((await store.read('a'))?.data).toBe(3)
    })

    it('replica update() merges onto a doc persisted by a previous process', async () => {
      const { store, reopen } = make()
      await store.create('a', { keep: 1 }, {})
      // Fresh store over the same table = restarted server with a cold cache.
      const restarted = reopen()
      const replica = restarted.open!('a')
      await nextChange(restarted, () => replica.update({ added: 2 }))
      expect((await restarted.read('a'))?.data).toEqual({ keep: 1, added: 2 })
    })

    it('replica delete(path) removes a key', async () => {
      const { store } = make()
      await store.create('a', { keep: 1, drop: 2 }, {})
      const replica = store.open!('a')
      await nextChange(store, () => replica.delete(['drop']))
      expect((await store.read('a'))?.data).toEqual({ keep: 1 })
    })

    it('replica subscribe fires for its own id only', async () => {
      const { store } = make()
      await store.create('a', 1, {})
      await store.create('b', 1, {})
      const replica = store.open!('a')
      let fired = 0
      const off = replica.subscribe(() => fired++)
      await store.apply({ id: 'b', update: 2, origin: 'x' })
      expect(fired).toBe(0)
      await store.apply({ id: 'a', update: 2, origin: 'x' })
      expect(fired).toBe(1)
      off()
      await store.apply({ id: 'a', update: 3, origin: 'x' })
      expect(fired).toBe(1)
    })

    it('rejects an unsafe table name', () => {
      const { reopen: _r, store: _s } = make()
      const bad = name === 'libsql' ? () => libsqlStoreServer({ client: createClient({ url: ':memory:' }), table: 'x; DROP' }) : () => pgStoreServer({ db: pgDb, table: 'x; DROP' })
      expect(bad).toThrow(/Invalid table name/)
    })
  })
}
