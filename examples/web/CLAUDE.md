# web example

Two workspace packages (glob `examples/web/*`): `server/` (Hono +
`@super-harness/core`+`server`, tsx-run) and `client/` (Vite React,
`@super-harness/react` + `@super-harness/shared` — no Mastra on the client).

- Server loads the **root** `.env` (`tsx --env-file=../../../.env`); exits 2
  without `AI_GATEWAY_API_KEY`. `SUPER_HARNESS_PORT` (4111) / `CHAT_MODEL`
  override.
- WS transport attaches to the node server **returned by** `@hono/node-server`'s
  `serve()` — upgrade requests on `/super-line` never reach Hono routing, so no
  Hono WS adapter is involved.
- **Storage backend is env-selected** (`SUPER_HARNESS_STORAGE`, default
  `libsql`). Mastra's ground truth and `serve()`'s tree Stores always share one
  database so they stay in sync:
  - `libsql` — one `@libsql/client` (`file:./dev.db`) backs both `LibSQLStore`
    (threads, recall, per-thread mode) AND the durable tree
    (`superline_harness_node` / `superline_harness_thread`). Durable here
    (unlike dev-server); refresh/late-join rebuild full history. Gitignored;
    delete `dev.db` to reset. (No `harness.db`.)
  - `postgres` — `@mastra/pg` `PostgresStore(PG_URL)`; `serve()` **reuses its
    pool** via `{ type: 'postgres', db: pg.db }` (superline_* beside mastra_* in
    one central PG, no Electric).
  - `pglite` — `PostgresStore(PG_URL)` for Mastra; `serve()`
    `{ type: 'pglite', pgUrl, electricUrl }` = central PG + per-node
    Electric-synced replicas. The multi-node choice (`docker-compose.yml`).
- **`docker-compose.yml`** boots the multi-node store-pglite demo: PG + Electric
  + 3 nodes + vite frontend + Control Center. One shared image (`Dockerfile`,
  repo-root context) runs both the node servers and vite, differing only by
  compose `command`. `env_file: ../../.env` feeds only `AI_GATEWAY_API_KEY`
  (never baked — root `.dockerignore` excludes `.env`). Cross-node proof: pick a
  node in the header selectbox, chat, then flip to another node — the same thread
  re-renders from that node's replica.
- **Node selection is a header selectbox, not the URL** (`src/lib/client.ts` +
  `src/main.tsx`). The frontend container sets `VITE_NODE_BASE_PORT=8800` → node
  N maps to `ws://<host>:<8800+N>/super-line` and the selectbox shows; without it
  (local `pnpm dev`) there's one node on `VITE_SUPER_HARNESS_URL ?? :4111` and no
  selectbox. Changing node recreates the client (new WS url): `main.tsx`'s `Root`
  holds `node` state, `useMemo`s one client per node, and CARRIES the current
  threadId across the swap so you stay on the same conversation. Nothing is in the
  URL — a refresh starts a fresh thread (resume from the sidebar).
- **Why flipping to another node shows the same live tree**: the client sends
  `resourceId: 'web'` and NO `userId`, so `serve()` resolves the store principal
  to `'web'` for every tab on every node (`userId ?? resourceId ?? 'local'`).
  node-1 grants its streaming node Resources to `'web'`; the grant replicates via
  Electric; a client on node-2 authenticates as `'web'` too, so it satisfies the
  read — including nodes created after it connected. Give tabs distinct `userId`s
  and cross-node reads break (node-1's `grantTo` wouldn't include the other
  principal).
- `send_report` (supervisor tool) is fake — it exists to exercise the approval
  flow (`'ask'`). Don't make it real.
- The super-line inspector is ON by default (`SUPER_HARNESS_INSPECTOR=0`
  disables) — read-only but UNAUTHENTICATED, fine only because this is a
  localhost demo. `pnpm -F @super-harness/web-server inspect` opens the
  Control Center. The flag lives on BOTH the transport and `serve()`.
- **Two separate cross-node planes.** The tree/Store data bus is Electric
  (`pglite` mode only). Presence + inspector fan-out is a SEPARATE broker-less
  libp2p mesh (mDNS discovery, gossipsub, `createLibp2pAdapter`) that every
  node joins regardless of storage backend — that's why connecting the Control
  Center to any one node surfaces the whole cluster, not just that node.
- The client vendors ai-elements + shadcn components under
  `src/components/{ai-elements,ui}/` — registry-generated code, don't hand-tune
  style there. The `ai` npm package is a type-only dep of those components; the
  wire is super-line, not the AI SDK.
- Core SUPPRESSES the `delegate` tool's own events — a delegation appears as a
  CHILD NODE (`childOrder`), never as a ToolState on the parent. The client
  interleaves text/tools/children chronologically via their `textOffset`s
  (`node-view.tsx` `segments()`).
- The wire state machine lives in `@super-harness/react` (`HarnessClient` +
  provider/hooks) — this example only owns UI + node/thread selection glue
  (`src/main.tsx` `Root`, `src/lib/client.ts`). Lifecycle rules (inferAsk
  last-root-only, busy vs parked ask, dismissAsk) are documented and tested in
  `packages/react`.
- Current-mode display falls back to `defaultModeId` after refresh — the
  contract has no "get thread mode" read; a live `modeChanged` corrects it.
