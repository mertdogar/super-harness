# @super-harness/server

`pnpm -F @super-harness/server test` — includes `wire.test.ts`, a real
WebSocket e2e through `serve()` with a fake-runner Harness, and
`composition.test.ts`, the same over a HOST server mounting the harness
(deliberately cast-free — it is the host-DX litmus test).

## Composition

`serve()` is a thin standalone host over two composable exports:
`await harnessStores(storage)` (spread into the host's `stores` config BEFORE
`createSuperLineServer`) and `mountHarness(srv, harness)` → `{ handlers,
close }` (handlers spread into the host's `implement()` **shared** block; the
mount attaches the bus → Projector → sink pipeline so requests and tree can't
be wired separately). Host obligations beyond that: merge `harnessSurface`
into the contract's `shared` block, ctx extends `HarnessCtx`, and `identify`
returns `ctx.userId` — see the gotchas below and `examples/composed-host`.

## Gotchas

- **`identify` is load-bearing, not cosmetic**: store ACL grants key on
  `ctx.userId`, and super-line's principal is `identify(conn) ?? conn.id`
  (random). A host that skips `identify` gets a working request surface and a
  silently empty tree — every store read denied. (`composition.test.ts`
  exists because of this.)
- **Resource-room membership is joined lazily** in the `harness.join` /
  `harness.listThreads` / `harness.createThread` handlers — there is no
  onConnection hook for a host to wire (rooms auto-remove on disconnect).

- **One table per Store namespace** — a shared table lets a node id and a
  thread id collide and clobber each other. Table names flatten the namespace
  dot (`harness.node` → `harness_node`); the shared-db backends
  (`libsql`/`postgres`) prefix `superline_` (`superline_harness_node`) so they
  sit safely beside Mastra's `mastra_*` tables in the same file/database.
  (Pre-composition tables — `node`, `superline_thread`, … — are orphaned, not
  migrated.)
- **Shared-db store backends** (`stores.ts`, `libsqlStoreServer` /
  `pgStoreServer`): async LWW ports of `sqliteStoreServer` over a connection the
  app already owns. Because the drivers are async but `ServerReplica` is sync,
  mutations ride a **per-resource promise chain** and `onChange` fires only
  AFTER the row is persisted — a `getSnapshot()`/`update()` cache backs the sync
  surface. Typed against structural driver subsets (`LibsqlClientLike` /
  `PgDbLike`), so this package imports NEITHER driver — same trick as `sink.ts`.
  `stores.test.ts` runs the suite against real `@libsql/client` (`:memory:`) and
  real Postgres via PGlite — SQL dialect is the whole risk surface, so fakes
  wouldn't earn their keep.
- **The sink writes via `handle.write()`, not the `open()` co-writer**
  (`sink.ts`): self-clustering stores (store-pglite) have no `open()`, and a
  whole-doc sink never needs the replica's getSnapshot/merge. Stream events fire
  per token, so writes are **coalesced per resource on a trailing debounce**
  (`flushMs`, default 150) — the first event `create()`s the Resource, later
  events flush the latest doc at most once per interval, and the final doc always
  lands. Clients render from the store snapshot + `onChange`; a reload reads the
  store. Cadence is app policy (see the store-pglite handoff §1 in super-line).
  `write()` tags co-writes `origin: 'harness'` (needs `@super-line/server` >=
  0.9.0) — cosmetic (inspector attribution only; echo-break is unaffected since
  no client shares that origin).
- **`pglite` backend is an optional peer** (`@super-line/store-pglite`),
  dynamically imported only when `storage.type === 'pglite'` — like the sqlite
  backend. Needs a running Electric service for live `onChange`.
- **`deleteThread` purges the tree** (`thread_deleted` in `serve.ts`): reads the
  durable thread doc, deletes every node doc it lists + the thread doc. Without
  this the docs outlive the thread and a reused threadId resurrects the deleted
  conversation via the sink's restart-merge base.
- **Restart safety**: `superlineTreeSink` reads the durable thread doc once
  and merges it as a base into every `writeThread` — without this a restarted
  server's first fold clobbers persisted history.
- **Late joiners**: the `join` handler grants the connecting user read on
  every node listed in the durable thread doc; node Resources created before
  the join carry only the old grants.
- `grantTo` on the sink is a **function** (evaluated per create) so principals
  who join mid-turn get onto subsequently created nodes.
- `resumeMessage` wraps `harness.resume` in try/catch because resume validates
  synchronously (unknown toolCallId, mid-turn thread) — a sync throw returns
  `{ ok: false }` instead of crashing the handler.
- Known upstream super-line bug: subscribe-time snapshot can arrive after
  live co-writer deltas and clobber newer client state. `wire.test.ts` keys
  final assertions off the event-stream rootId (NOT `prev.turns`) for this
  reason — do not "fix" it client-side; fix belongs in super-line.
- Sink types are structural subsets of super-line handles (see `sink.ts`) to
  stay fakeable and dodge multi-`core` type skew — keep it that way.
