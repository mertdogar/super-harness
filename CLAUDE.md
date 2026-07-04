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
  types, `apply()` fold, client Store view. No Mastra, no server deps.
- `packages/core` — the engine: `createHarness` (bus, follow-up queue,
  approvals, suspensions, modes, threads). Mastra is a **peer** dep.
- `packages/server` — super-line binding: standalone `serve(harness, config)`
  OR composition into a host server (`harnessStores` + `mountHarness`),
  durable Store sink, contract implementation.
- `packages/react` — headless React client: framework-free `HarnessClient`
  (wire state machine, owns a socket via `url` or borrows the host app's via
  `client`) + `HarnessProvider`/`useHarness` hooks. No components.
- `packages/tui` — terminal client (OpenTUI cockpit + headless shell). **Bun
  only** (`bun:ffi`).
- `examples/dev-server` — runnable supervisor + worker demo.
- `examples/composed-host` — the composition reference: a host super-line
  server mounting the harness beside its own surface, one shared client.
- `examples/web` — fullstack showcase: Hono backend (`web/server`) + Vite/React/
  shadcn/ai-elements client (`web/client`). See its CLAUDE.md.
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
- The sqlite Store backend needs `better-sqlite3`'s native build — already
  allowlisted via `allowBuilds` in `pnpm-workspace.yaml`, so a plain
  `pnpm install` handles it.
- Known upstream super-line bug: a store subscribe's initial snapshot can
  arrive after live co-writer deltas and clobber newer client state. Don't
  paper over it here — `packages/server/src/wire.test.ts` keys assertions off
  the event stream for this reason; the fix belongs in super-line.
- The `.claude/skills/super-line` skill documents the super-line API — read it
  before touching contract/Store code.

## Wire compatibility

`shared` is the single source of truth for the contract AND the tree fold
(`apply`). Server and clients must run the same `shared` version — the fold is
not forward-compatible across event-vocabulary changes.

## Composition (super-line ≥0.9)

super-harness is a composable super-line **library**: `shared` exports
`harnessSurface` (a `defineSurface` fragment; every identifier is
`harness.`-prefixed — requests/events/stores `harness.*`, rooms `harness:*`),
a host merges it into its contract's `shared` block and mounts with
`harnessStores` + `mountHarness`; `serve()` is the same pieces standalone.
See `examples/composed-host` for the four host obligations. All
`@super-line/*` packages are **peer** deps of shared/server/react (one core
instance across host + library, per the super-line composition guide). The
published `@super-line/server`/`client`/`store-*` still carry core as a
REGULAR dependency (`^0.8.0`), so `pnpm-workspace.yaml` carries an
`overrides: '@super-line/core': ^0.9.0` shim to force one copy — drop it once
upstream makes core a true peer.
