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
- **Explicit plugin composition**, not the harness `serve()` sugar: the server
  builds its contract with `defineContract({ plugins: [harnessContract()] })`,
  constructs the tree collections backend from `SUPER_HARNESS_STORAGE`, and calls
  `createSuperLineServer(contract, { collections, authenticate, identify, plugins:
  [harness(engine), ...(INSPECTOR ? [inspector()] : [])], adapter })`. The inline
  `authenticate` preserves `serve()`'s `userId ?? resourceId ?? 'local'` fallback
  (load-bearing — see the cross-node note below).
- **Storage backend is env-selected** (`SUPER_HARNESS_STORAGE`, default
  `libsql`). Mastra's ground truth and the harness tree's COLLECTIONS backend are
  chosen together; the server builds the collections backend inline (what
  `serve()` used to do internally) and passes it to `createSuperLineServer`:
  - `libsql` — `@libsql/client` (`file:./dev.db`) backs `LibSQLStore` (Mastra
    threads/recall/mode); the tree rides `sqliteCollections({ file: './harness.db' })`.
    Durable here (unlike dev-server); refresh/late-join rebuild full history.
    Both files are gitignored — delete them to reset.
  - `postgres` — `@mastra/pg` `PostgresStore(PG_URL)` for Mastra; the tree still
    uses the local `sqliteCollections` file (this mode keeps no central PG copy
    of the tree).
  - `pglite` — `PostgresStore(PG_URL)` for Mastra; the tree rides
    `pgliteCollections({ pgUrl, electricUrl })` (dynamic import) = central PG +
    per-node Electric-synced replicas. The multi-node choice (`docker-compose.yml`).
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
  `resourceId: 'web'` and NO `userId`, so the server's inline `authenticate`
  resolves the principal to `'web'` for every tab on every node
  (`userId ?? resourceId ?? 'local'` — preserved verbatim from `serve()`).
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
  Control Center. `SUPER_HARNESS_INSPECTOR` gates whether `inspector()` is added
  to `createSuperLineServer`'s `plugins` (after `harness(engine)`).
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
