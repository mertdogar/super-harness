# PLAN — super-harness as a super-line plugin (Collections + auth)

Status: **APPROVED** (grill-me 2026-07-06). Convert super-harness from the super-line
*composition* pattern (`harnessSurface` + `harnessStores` + `mountHarness`) into a first-class
super-line **plugin** (`harness()`), and move the tree off the now-deprecated LWW Stores onto
**Collections**, with the token firehose split off as ephemeral room events.

## Why

- The LWW `store-*` family super-harness rides (`store-memory`/`store-sqlite`/`store-pglite` +
  the custom `libsqlStoreServer`/`pgStoreServer`) is **deprecated** (ADR-0006). The CRDT
  `store-sync*` family is not — but the harness tree is not a merge-CRDT doc; it's relational
  rows + an ephemeral token stream. Collections are the right primitive.
- super-line 0.10 ships a plugin system (`SuperLinePlugin`) whose handler keys subtract from
  `implement()` for **every block incl. `shared`**, plus contract-fragment plugins
  (`defineContractPlugin`) that contribute collections/surface/roles. So the whole composition
  apparatus collapses to one `harness()` plugin line + one `harnessContract()` fragment.
- Pairing with `@super-line/plugin-auth` supplies `identify` → kills the #1 documented footgun
  (a host that forgets `identify` gets a silently empty tree; `composition.test.ts` exists for it).

## Settled design (from the grill)

1. **Storage = Collections** (option C), not LWW Stores, not CRDT sync.
2. **Streaming model (c):** structural state persists to rows; token deltas
   (`reasoning`/`text`/`argsText`) broadcast over the existing `harness:thread:<id>` room as
   **ephemeral** events and are **not** persisted per-token; the **final** strings land on the
   row once at `node_end`/`tool_end`. Droppable preview (a lost frame self-heals from the final
   write). Optional coarse checkpoint only if reload-mid-stream partial text is later missed.
3. **Transport:** reuse the existing per-thread room for the token stream (a separate room
   wouldn't fix socket-level head-of-line blocking anyway; tokens are droppable).
4. **Security spine = per-thread membership.** A `harness.membership` collection; RLS read
   policy `isIn('threadId', joinedThreads(principal))`. Deletes the per-node grant loop + the
   late-joiner back-grant.
5. **`resourceId` = optional grouping column** on `harness.threads` (sidebar filter), decoupled
   from security.
6. **`harness.tools` is its own collection** (not a nested node column) — `argsText` streams;
   a small separate row avoids rewriting the node's blob, and enables cross-node tool queries.
7. **Thread-list room broadcasts retired** — `threadCreated/Renamed/Deleted` become row deltas
   on a live `harness.threads` subscription.
8. **Backend-agnostic:** the host owns the single `collections:` backend; the harness declares
   schemas + policies only. Even `collections-pglite` is fine now (tokens are ephemeral).
9. **Auth-agnostic:** the harness reads `ctx.userId`; pairs with `plugin-auth` by convention,
   no hard dep. Control authz = a `role: 'viewer'|'operator'` column on `harness.membership`
   (per-run), checked in the control handlers; global auth `roles[]` reserved for coarse
   admin/revoke gates. An API-key client with `role:'operator'` = a headless driver.
10. **Package topology:** keep the 5-package split; reshape entry points to the plugin idiom
    (`harnessContract()` / `harness()` / `harnessClient()`). `serve()` survives as thin
    standalone sugar over the plugin.
11. **Control-signal reload durability:** approvals reconstruct from the `harness.tools` row;
    suspensions persist `{resumeSchema, request}` onto the node row (`pendingResume`, set on
    suspend / cleared on resume). Live event = the nudge; the row = the render truth.

## Data model (declared on the contract via `harnessContract()`)

| Collection | key | columns |
|---|---|---|
| `harness.threads` | `id` (threadId) | `resourceId?`, `title?`, `turns: string[]`, `todos: TodoItem[]`, `createdAt`, `updatedAt` |
| `harness.nodes` | `id` (nodeId) | `threadId`, `parentNodeId: string\|null` (self-ref advisory FK), `depth`, `agentType?`, `task?`, `status`, `reasoning` (final, set at `node_end`), `text` (final), `toolOrder: string[]`, `childOrder: string[]`, `usage?`, `durationMs?`, `error?`, `pendingResume?: {resumeSchema?, request?}` |
| `harness.tools` | `id` (toolCallId) | `threadId`, `nodeId`, `toolName`, `status`, `argsText` (final), `args?`, `result?`, `isError?`, `textOffset?` |
| `harness.membership` | `id` (`${threadId}:${userId}`) | `threadId`, `userId`, `role: 'viewer'\|'operator'`, `joinedAt` |

`references`: `nodes.threadId→threads`, `nodes.parentNodeId→nodes`, `tools.nodeId→nodes`,
`tools.threadId→threads`, `membership.threadId→threads` (advisory; the client still folds the
adjacency list into the tree — no recursive query).

## RLS (plugin `policies`, deny-by-default)

- `joinedThreads(principal)` = `srv.collection('membership').snapshot({filter: eq('userId', principal)})` → threadIds.
- `membership`: `read = eq('userId', principal)`; no `write` (server co-writes in the join handler).
- `nodes` / `tools`: `read = isIn('threadId', await joinedThreads(principal))`; no `write`.
- `threads`: `read = isIn('id', await joinedThreads(principal))`; no `write`.

## Wire surface (`harnessContract()` fragment, all in `shared`)

Requests (`clientToServer`) — unchanged names, still `shared`; control handlers check membership role:
`harness.join`, `harness.sendMessage`, `harness.resumeMessage`, `harness.abort`,
`harness.respondToApproval`, `harness.switchMode`, `harness.listModes`, `harness.listThreads`,
`harness.createThread`, `harness.renameThread`, `harness.deleteThread`.

Events (`serverToClient`):
- Keep: `harness.suspended`, `harness.approvalRequired`, `harness.modeChanged`, `harness.followUpQueued`.
- **Drop:** `harness.threadCreated/threadRenamed/threadDeleted` (now `harness.threads` row deltas).
- **Add (token preview):** `harness.reasoningDelta`, `harness.textDelta`, `harness.toolInputDelta`
  (payload: `{threadId, nodeId, toolCallId?, text|argsTextDelta}`) — ephemeral, room-broadcast.

**Breaking wire ABI** — server + all clients move together, no back-compat.

## Package targets

- **`@super-harness/shared`** → export `harnessContract()` (`defineContractPlugin`: 4 collection
  defs + surface). Keep row types (`NodeState`/`ToolState`/`ThreadRow`/etc.) + the client fold
  (`subscribeTree` reworked to assemble from collection subscriptions + token events). Drop the
  old `harnessSurface`/`contract`/store-namespace/room-helper exports that no longer apply
  (keep `harnessThreadRoom`/`harnessResourceRoom` — rooms still used).
- **`@super-harness/core`** → unchanged (Mastra peer; `createHarness`, `apply`, `Projector`,
  `TreeSink`). The `TreeSink`/`Projector` may gain a "persist-structural-only" mode.
- **`@super-harness/server`** → export `harness(harnessInstance, opts)` → `SuperLinePlugin
  {policies, handlers, setup}`. `setup`: subscribe bus → in-memory fold → broadcast token
  deltas to the room + co-write rows on structural/terminal events + relay session signals +
  dispose. `serve()` reimplemented over the plugin. **Delete** `stores.ts`
  (`libsqlStoreServer`/`pgStoreServer`), `harnessStores`, `mountHarness`, and the store-based
  `sink.ts` (replaced by a collections writer).
- **`@super-harness/react`** → export `harnessClient()` → `SuperLineClientPlugin` + collection
  tree assembly. Drop `harnessClientStores()`.
- **`@super-harness/tui`** → consume the above.

## Host wiring (the payoff)

```ts
const api = defineContract({
  plugins: [harnessContract(), authContract()],
  roles: { user: {/*…*/}, admin: {/*…*/} },
})
const srv = createSuperLineServer(api, {
  transports, collections: sqliteCollections(),
  authenticate: authKit.authenticate, identify: authKit.identify,
  plugins: [harness(myHarness), auth(authKit)],
})
srv.implement({ /* harness.* NOT required — the plugin owns them */ })
```

## Steps (each: implement → typecheck → test → commit)

0. **Deps prerequisite.** Bump `@super-line/client` → `^0.10`; add `@super-line/collections-memory`,
   `@super-line/collections-sqlite` (+ `collections-pglite` optional peer); drop
   `@super-line/store-memory`/`store-sqlite`/`store-pglite`. `pnpm install`, typecheck.
1. **shared: contract fragment + schemas.** Add the 4 collection defs + reworked surface as
   `harnessContract()`. Keep/adapt row types. Unit-test the fragment shape + `RowOf` inference.
2. **shared: client fold.** Rework `subscribeTree` to assemble the tree from `nodes`/`tools`/
   `threads` collection subscriptions + token-delta events (in-memory overlay for live text).
   Port `tree.test.ts`.
3. **server: the collections writer + plugin.** Replace `sink.ts` with a collections co-writer
   (upsert node/tool/thread rows on structural/terminal events; skip strings until terminal;
   `pendingResume` on suspend). Write `harness()` (`policies`+`handlers`+`setup`), incl. token
   broadcast, membership-based RLS + control-role checks, manual `deleteThread` cascade.
4. **server: `serve()` over the plugin** + delete `stores.ts`/`harnessStores`/`mountHarness`.
   Port `wire.test.ts` + `composition.test.ts` to the plugin + collections backend.
5. **react: `harnessClient()`** + collection tree assembly; drop `harnessClientStores()`.
6. **tui** migrate to `harnessClient()`/`serve()`.
7. **examples** migrate: `dev-server`, `composed-host`, `web`, `plan-board`. Add a
   `plugin-auth`-paired auth example (or wire it into `composed-host`).
8. **docs**: update CLAUDE.md files (root + per-package) to the plugin/collections model;
   refresh gotchas.

## Verify-before-build items folded into steps

- `defineContractPlugin` collections+surface merge — proven in core (`contract.ts:133`). ✓
- Server co-writer `insert/update/delete/snapshot`, **no `batch`** → manual cascade (step 3). ✓
- Client `collection().subscribe()` + reconnect re-diff feeds the fold (step 2/5). ✓
- Structural writes: low-frequency → write immediately; **drop the 150ms coalescer** (step 3).

## Out of scope / consult-first

- Data migration of old Store docs (dev-stage; orphaned).
- `@mastra/core` version pin (untouched).
- Any change to the core engine's turn protocol beyond an optional persist-mode flag — **consult
  before altering `@super-harness/core` semantics**.
