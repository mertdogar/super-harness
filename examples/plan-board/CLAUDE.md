# plan-board example

Two workspace packages (glob `examples/plan-board/*`): `server/` (tsx-run
`@super-harness/core`+`server`) and `client/` (Vite React, `@super-harness/react`
+ `@super-harness/shared` — no Mastra on the client). It runs on the SAME
tailwind + shadcn `ui/` + `ai-elements/` stack as `examples/web` (those two dirs
plus `node-view.tsx` and `approval-dialog.tsx` are copied verbatim from web) — it
exists to showcase the **todo/task** feature plus ask_user, delegation,
streaming, and an approval gate in a plan-first layout instead of web's chat.

- Server loads the **root** `.env` (`tsx --env-file=../../../.env`); exits 2
  without `AI_GATEWAY_API_KEY`. `SUPER_HARNESS_PORT` (4113) / `CHAT_MODEL`
  (default `anthropic/claude-sonnet-4.5`) override.
- **The four beats are driven by instructions, not registration.** `todo`,
  `ask_user`, and `delegate` are injected by the harness per turn — never added
  to the Agent. The supervisor's scripted instructions make it (1) ask_user once,
  (2) `todo` a plan, (3) resend the full list on each status change, (4) delegate
  a research item to `researcher`, (5) call `publish_plan` at the end.
- **Gating is keyed by tool NAME in three places** that must match:
  `createTool({ id: "publish_plan" })`, the Agent key `tools: { publish_plan }`,
  and `permissions: { tools: { publish_plan: "ask" } }`. Miss one and the gate
  silently never arms. The supervisor needs the tool BOTH on its Agent (so the
  LLM can call it) AND in `permissions` (so calling it parks an approval).
- **Model default is bumped to sonnet** (not the repo-wide haiku) because the
  scripted suspend/resume sequence — ask_user then, after resume, delegate then
  the gated tool — needs reliable instruction-following.
- **Mastra memory (`dev.db`) is on deliberately.** Without it
  `harness.listThreads` throws, and the react client calls it on connect, which
  would surface a spurious `notice` banner. Memory also gives cross-turn recall
  (revise the plan). The tree Store stays `{ type: "memory" }` — the client mints
  a fresh threadId per load, so tree durability buys nothing. `dev.db*` is
  gitignored (root `*.db`).
- **Client is owned/url mode.** `createHarnessClient({ url, threadId: nanoid() })`
  passed as the `client` INSTANCE to `<HarnessProvider client={…}>` (not a
  config). `useHarness()` returns state directly; `useHarnessClient()` gives the
  methods. Don't pass `stores` in url mode — it defaults to in-memory replicas.
- Client actions: `client.send(goal)`, `client.reply(text)` answers a
  `pendingAsk`, `client.respond("approve" | "decline")` resolves a
  `pendingApproval`. Surface `state.notice` — `reply`/`respond` keep the pending
  and set a notice on server `ok:false` instead of throwing.
- **Todos are thread-level ambient** (`tree.todos`), NOT on any NodeState — the
  fold ignores the `todo` event (`case "todo": break`); the projector carries it
  on the thread doc. Guard `tree.todos ?? []` (undefined until the first plan).
- The execution view reuses web's `NodeView` verbatim: reasoning collapsibles,
  `ai-elements` Tool cards, and delegated child nodes nested in a collapsible
  Task, interleaved chronologically by `textOffset`. The plan checklist
  (`tree.todos`) is the plan-board-specific piece — a shadcn `Card` with lucide
  status icons (`CircleIcon` / `LoaderIcon` spin / `CircleCheckBigIcon`).
- `components/{ai-elements,ui}` + `node-view.tsx` + `approval-dialog.tsx` are
  copied from `examples/web/client` — registry-generated, don't hand-tune. If web
  updates them, re-copy rather than diverge. The ONLY hand-written client files
  are `App.tsx`, `main.tsx`, and `lib/client.ts`.
