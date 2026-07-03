# @super-harness/server

`pnpm -F @super-harness/server test` — includes `wire.test.ts`, a real
WebSocket e2e through `serve()` with a fake-runner Harness.

## Gotchas

- **One table per Store namespace** (`table: ns` in `sqliteStoreServer`) — a
  shared table lets a node id and a thread id collide and clobber each other.
  The shared-db backends (`libsql`/`postgres`) prefix `superline_` so they sit
  safely beside Mastra's `mastra_*` tables in the same file/database.
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
