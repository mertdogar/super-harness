# canvas example

Three workspace packages (glob `examples/canvas/*`): `shared/` (the merged
contract + scene schema both halves import), `server/` (tsx-run
`@super-harness/core`+`server` with five canvas tools over a server-side
`CrdtServerReplica`), and `client/` (Vite React on web's tailwind + shadcn
`ui/` + `ai-elements/` stack). It is the CRDT/cluster flagship: the harness
supervisor co-edits `document`-mode CRDT scene docs live beside the user's
drags, with a TanStack DB boards lobby and an optional 2-node
Postgres + Electric docker cluster.

- Server loads the **root** `.env` (`tsx --env-file=../../../.env`); exits 2
  without `AI_GATEWAY_API_KEY`. `SUPER_HARNESS_PORT` (4116) / `CHAT_MODEL`
  (default `anthropic/claude-sonnet-4.5`) override. `SUPER_HARNESS_STORAGE`
  selects `memory` (default) or `pglite` (docker cluster; needs `PG_URL`,
  uses `ELECTRIC_URL`, dynamic-imports the pglite trio + libp2p adapter).
- **Gating is keyed by tool NAME in three places** that must match:
  `createTool({ id: "clear_board" })`, the Agent key `tools: { clear_board }`,
  and `permissions: { tools: { clear_board: "ask" } }`. Miss one and the gate
  silently never arms.
- **The `[board:<id>]` prefix is the board-routing convention.** The client
  prefixes every sent message with `[board:<activeBoardId>] ` (App.tsx); the
  supervisor's instructions tell it to pass that id as `boardId` to EVERY tool.
  There is no server-side routing — break the prefix and the agent edits the
  wrong board.
- **CRDT schema rule: every field is `.catch(default)`** (`shared/scene.ts`).
  Validate-before-commit runs against *post-merge* state and a concurrent
  overwrite is transiently a delete-then-insert — a hard-required field would
  reject and resync-churn the doc (upstream ADR-0007). Never add a required
  field to `sceneSchema` without a `.catch`.
- **Tool write path**: `scenes.read(boardId)` (strong-folds so `getSnapshot()`
  is current even on a lagging Electric replica — `open()` is sync and can't
  await) → `scenes.open(boardId, { origin: "agent" })` → one Store primitive →
  `close()` in `finally`. `delete(["shapes", id])` is the only key-removing
  surface; `clear_board` deletes per shape, NEVER a whole-doc set (a set would
  clobber concurrent edits; per-path deletes merge).
- **Seeding is guarded for restarts and cluster races**: `scenes.create`
  wrapped in try/catch (CONFLICTs on a durable backend / second node), `boards`
  read-checked then insert-caught. Scene-doc lifecycle is coupled to the lobby
  via `collections.onChange` on `boards` — client inserts a row, the server
  creates the doc; both callbacks `.catch(() => {})` because create/delete race
  across nodes.
- **Client is borrowed mode.** ONE `createSuperLineClient` carries boards rows,
  scene docs, and the harness surface; `createHarnessClient({ client })`
  borrows it (close() only detaches). `crdtCollections:
  crdtCollectionsClient()` is the CLIENT's job — the harness never touches
  CRDT docs; omit it and `sl.collection("scenes").open()` has no engine.
  Node swaps (`main.tsx` Root) close the previous socket themselves and carry
  the threadId across.
- **Shared principal `canvas` is load-bearing for cross-node reads.** The
  client sends `resourceId: 'canvas'`, no `userId`; the server's `authenticate`
  preserves serve()'s `userId ?? resourceId ?? 'local'` fallback. Every tab on
  every node is principal `canvas`, so the `harness.membership` row written on
  node-1 admits readers on node-2, and `boards` rows insert with
  `createdBy: PRINCIPAL` to pass the creator-only write policy. Distinct
  userIds would break both.
- `boards` policies are LWW-row RLS (read filter / write bool over rows);
  `scenes` policies are CRDT-shaped **bools only** (`() => true`), not filters.
- The lobby recreates its TanStack collection per node swap with an overridden
  id (`superline:boards:<seq>`) — two live instances during the swap would
  collide in TanStack's registry. Mutations are optimistic; surface rejections
  via `.isPersisted.promise.catch`, never throw.
- `use-doc.ts`: `doc.ready` REJECTS on NOT_FOUND — a fresh board's doc is
  created server-side off the change feed, so rejection is usually a race (or
  a lagging replica); it retries bounded (10 × 1.5s) as `missing` instead of
  crashing. Relatedly (repo-wide caveat): await readiness before depending on
  live updates — a late initial snapshot can clobber newer state upstream.
- `components/{ai-elements,ui}` + `node-view.tsx` + `approval-dialog.tsx` are
  copied from `examples/web/client` — registry-generated, don't hand-tune. If
  web updates them, re-copy rather than diverge. Hand-written client files:
  `App.tsx`, `main.tsx`, `lib/client.ts`, `hooks/use-doc.ts`,
  `components/{board-canvas,boards-lobby}.tsx`.
- Mastra memory is on (LibSQL `dev.db` locally, central PG in pglite mode) —
  without it `harness.listThreads` throws and the react client calls it on
  connect. `maxSteps: 30` because a multi-shape edit is many tool steps.
