# @super-harness/server

`pnpm -F @super-harness/server test` — `sink.test.ts` (the collections writer,
unit), `wire.test.ts` (a real WebSocket e2e through `serve()` with a fake-runner
Harness), and `composition.test.ts` (the same over a HOST server merging
`harnessContract()` + `plugins:[harness()]` — the cast-free host-DX litmus).

## The plugin

`harness(engine, opts)` → a `SuperLinePlugin { policies, handlers, setup }`:

- **policies** — membership-based RLS. `harness.nodes`/`harness.tools` read
  `isIn('threadId', joinedThreads(principal))`; `harness.threads` reads
  `eq('resourceId', ctx.resourceId)` (sidebar) falling back to membership;
  `harness.membership` reads `eq('userId', principal)`. Writes are all deny-all
  — the plugin co-writes server-authoritatively (bypasses policy).
- **handlers** — the `harness.*` requests (subtracted from the host's
  `implement()`). Control ops (send/resume/abort/approve/switchMode/rename/
  delete) reject a `viewer` membership; join/list are open to any member.
- **setup(ctx)** — subscribes the harness bus: token deltas broadcast to the
  per-thread room (ephemeral, never persisted) + fold into the projector for
  final strings; structural events fold → the collections writer; session
  signals broadcast; thread metadata + `pendingResume` persist; `thread_deleted`
  cascades. Returns the bus unsubscribe (disposed on `server.close()`).

`serve(engine, cfg)` is the standalone host: a collections backend
(`memory`/`sqlite`/`pglite`) + default query-`authenticate` + `identify` +
`plugins:[harness(engine), ...cfg.plugins]`. The `plugins?` passthrough composes
`inspector()` (`@super-line/plugin-inspector`) or `auth()`.

## Gotchas

- **`identify` is load-bearing**: the harness RLS keys on `ctx.userId`, and
  super-line's principal is `identify(conn) ?? conn.id` (random). A host that
  skips `identify` gets a working request surface and a silently empty tree —
  every membership-gated read denied. With `@super-line/plugin-auth`, `identify`
  comes from the session (`composition.test.ts` covers the query-auth path).
- **The host owns the ONE collections backend** — `harness()` declares schemas
  (via the fragment) + policies, never a backend. Even `collections-pglite`
  works now: tokens are ephemeral, so only low-frequency structural rows hit it.
- **The collections writer (`sink.ts`)** dedups by the persistable row
  projection: a running node's `reasoning`/`text` are `''` (model c — the live
  stream rides the room), so a delta-only `writeNode` is a no-op; the final
  strings land at `node_end`. Its write lanes are keyed by **(collection, id)**
  — a `threadId` and a `toolCallId` can collide, and sharing one lane routes a
  tool write down the thread row's insert/update state. Tools are their OWN
  collection so per-token `argsText` writes don't rewrite the node blob.
- **`join` = add to the thread room + insert a membership row** (default
  `operator`; `opts.roleFor`/`defaultRole` override). No Store pre-create / no
  per-node ACL grant loop — one membership insert replaces N `setAccess` calls.
- **`deleteThread` cascades** (`thread_deleted`): snapshot + delete every
  `harness.nodes`/`tools`/`membership` row for the thread, then the thread row.
  There's no server-side `batch()`, so it's per-row.
- **`pendingResume`** parks a suspension's `{resumeSchema, request}` on the node
  row (set on `suspended`, cleared when the tool settles) so a mid-turn reload
  rebuilds the prompt. Approvals rebuild from the tool row alone.
- Thread-list reactivity is **`harness.threads` row deltas**, not events — the
  `threadCreated/Renamed/Deleted` events are gone; a metadata change is a row
  update via the writer's `setThreadMeta`.
- Known upstream super-line snapshot race: a subscribe's initial snapshot can
  arrive after live deltas and clobber a pre-existing row's updates. `await
  sub.ready` before mutating; the fix belongs in super-line.
- Sink/collection-handle types are structural subsets of super-line handles so
  the writer stays fakeable and dodges multi-`core` type skew — keep it that way.
