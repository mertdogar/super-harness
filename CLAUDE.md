# super-harness

Multi-agent harness: a supervisor Mastra Agent delegating to subagent Agents,
with full-fidelity streaming, HITL approvals/suspensions, modes, and threads —
transport-free in `core`, exposed over super-line WebSockets by `server`.

## Commands

```bash
pnpm install
pnpm build          # tsup (core & server only; shared/tui are source-run)
pnpm test           # vitest in shared/core/server (--if-present; no network — fakes throughout)
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm format         # oxfmt
```

Run the demo: `pnpm -F @super-harness/dev-server start` (needs
`AI_GATEWAY_API_KEY` in root `.env`), then
`pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line`.

## Layout

- `packages/shared` — isomorphic wire layer: super-line contract, event/tree
  types, `apply()` fold, client tree view. No Mastra, no server deps.
- `packages/core` — the engine: `createHarness` (bus, follow-up queue,
  approvals, suspensions, modes, threads). Mastra is a **peer** dep.
- `packages/server` — super-line binding: standalone `serve(harness, config)`
  OR the `harness(engine)` plugin composed into a host server, durable
  collections writer (`sink.ts`), contract implementation.
- `packages/react` — headless React client: framework-free `HarnessClient`
  (wire state machine, owns a socket via `url` or borrows the host app's via
  `client`) + `HarnessProvider`/`useHarness` hooks. No components.
- `packages/tui` — terminal client (OpenTUI cockpit + headless shell). **Bun
  only** (`bun:ffi`).
- `examples/plugin-usage` — the getting-started showcase: a host adds the
  harness with one `plugins: [harness()]` line + `harnessContract()`, driven by a
  self-contained `diffTree()` streaming terminal client. Start here.
- `examples/dev-server` — runnable supervisor + worker demo.
- `examples/composed-host` — the composition reference: a host super-line
  server mounting the harness beside its own surface, one shared client.
- `examples/auth` — the harness plugin paired with `@super-line/plugin-auth`:
  real sign-up/sign-in, identity → the collection principal, one socket.
- `examples/web` — fullstack showcase: Hono backend (`web/server`) + Vite/React/
  shadcn/ai-elements client (`web/client`). See its CLAUDE.md.
- `examples/plan-board` — todo/task showcase: a scripted planner
  (`plan-board/server`) + a plan-first client (`plan-board/client`) on web's
  shadcn/ai-elements stack, rendering the live plan, delegation, ask_user, and an
  approval gate. See its CLAUDE.md.
- `examples/mastra-playground` — standalone Mastra scratchpad, NOT wired to
  the harness.

## Gotchas

- Packages are source-exported (`main`/`types` → `./src/index.ts`), so the
  workspace runs without a build step during development.
- `@mastra/core` is pinned to `1.49.0-alpha.2` everywhere; keep the core/server
  peer ranges and every example in sync when bumping.
- `.env` (root) is gitignored and must never be committed; `.env.example` is
  the template. Never print the real `AI_GATEWAY_API_KEY`.
- `pnpm format:check` fails repo-wide today (no oxfmt config yet) — it is not
  part of the definition of done.
- The sqlite COLLECTIONS backend needs `better-sqlite3`'s native build —
  already allowlisted via `allowBuilds` in `pnpm-workspace.yaml`, so a plain
  `pnpm install` handles it.
- Known upstream super-line bug: a collection/store subscribe's initial
  snapshot can arrive after live co-writer deltas and clobber newer client
  state. Don't paper over it here — a client must `await sub.ready` before it
  depends on live updates (`wire.test.ts` does this before mutating a
  pre-existing row); the fix belongs in super-line.
- super-line client teardown mid-subscription rejects `DISCONNECTED` unhandled
  (`void trackRequest` on close) — e2e test clients pass `onError: () => {}` to
  swallow it; a real app rarely closes mid-turn.
- The `.claude/skills/super-line` skill documents the super-line API — read it
  before touching contract/collection code.

## Wire compatibility

`shared` is the single source of truth for the contract AND the tree fold
(`apply`). Server and clients must run the same `shared` version — the fold is
not forward-compatible across event-vocabulary changes.

## The plugin model (super-line ≥0.10)

super-harness ships as a super-line **plugin**, not a hand-wired composition.
Two halves:
- `shared` exports **`harnessContract()`** — a `defineContractPlugin` fragment
  contributing the four `harness.*` COLLECTIONS (`threads`/`nodes`/`tools`/
  `membership`) + the harness surface on `shared`. A host merges it via
  `defineContract({ plugins: [harnessContract(), …] })`.
- `server` exports **`harness(engine)`** — a `SuperLinePlugin` (policies +
  handlers + setup). The host adds it to `plugins: [...]`; `harness.*` handler
  keys are subtracted from `implement()`. The host provides ONE `collections:`
  backend (serves the harness + the host's own collections) and — via
  `identify` — the `ctx.userId` principal the harness RLS keys on.
- `react` exports **`createHarnessClient()`** / the headless `HarnessClient`, driving
  the tree over `client.collection()`.

`serve(engine, cfg)` is the same pieces standalone (it owns the backend +
default query-auth + `identify`), with a `plugins?` passthrough to compose
`inspector()`/`auth()` beside the harness. See `examples/composed-host` (the
composition reference) and `examples/auth` (paired with `@super-line/plugin-auth`).

All `@super-line/*` packages are **peer** deps of shared/server/react (one core
instance across host + library). The published `@super-line/*` still carry core
as a REGULAR dependency (`^0.10.1`), so `pnpm-workspace.yaml` carries an
`overrides: '@super-line/core': ^0.10.1` shim to force one copy — drop it once
upstream makes core a true peer.

## Auth

The harness is **auth-agnostic**: it reads `ctx.userId` however the host
supplies it (query-param dev auth, `@super-line/plugin-auth`, or a custom
scheme). Control ops (send/resume/abort/approve/switchMode/delete) reject a
`viewer` membership; read ops don't — the viewer/operator split is a `role`
column on `harness.membership` (per-run), NOT a connection role. Pair with
`@super-line/plugin-auth` (`examples/auth`) and `identify` supplies the
principal for free. Caveat: plugin-auth ships zod 3, super-harness zod 4 — a
merged contract's exported type needs a loose `Contract` annotation (TS2742)
until the versions align upstream.
