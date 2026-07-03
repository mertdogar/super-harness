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
- **One database.** The same `@libsql/client` (`file:./dev.db`) backs both
  Mastra's `LibSQLStore` (threads, recall, per-thread mode) AND `serve()`'s
  durable tree Stores (`storage: { type: 'libsql', client }` → `superline_node`
  / `superline_thread` tables). The tree IS durable here, unlike dev-server;
  page refresh / late joiners rebuild full history. Gitignored; delete `dev.db`
  to reset everything. (There is no `harness.db` anymore.)
- `send_report` (supervisor tool) is fake — it exists to exercise the approval
  flow (`'ask'`). Don't make it real.
- The super-line inspector is ON by default (`SUPER_HARNESS_INSPECTOR=0`
  disables) — read-only but UNAUTHENTICATED, fine only because this is a
  localhost demo. `pnpm -F @super-harness/web-server inspect` opens the
  Control Center. The flag lives on BOTH the transport and `serve()`.
- The client vendors ai-elements + shadcn components under
  `src/components/{ai-elements,ui}/` — registry-generated code, don't hand-tune
  style there. The `ai` npm package is a type-only dep of those components; the
  wire is super-line, not the AI SDK.
- Core SUPPRESSES the `delegate` tool's own events — a delegation appears as a
  CHILD NODE (`childOrder`), never as a ToolState on the parent. The client
  interleaves text/tools/children chronologically via their `textOffset`s
  (`node-view.tsx` `segments()`).
- The wire state machine lives in `@super-harness/react` (`HarnessClient` +
  provider/hooks) — this example only owns UI + the `?thread=` URL glue
  (`src/lib/client.ts`). Lifecycle rules (inferAsk last-root-only, busy vs
  parked ask, dismissAsk) are documented and tested in `packages/react`.
- Current-mode display falls back to `defaultModeId` after refresh — the
  contract has no "get thread mode" read; a live `modeChanged` corrects it.
