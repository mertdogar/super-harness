# @super-harness/react

`pnpm -F @super-harness/react test` — vitest, no network: tests drive the
state machine through the `wire` config seam (a structural fake super-line
client + fake Store handles).

- `harness-client.ts` is the engine; `react.ts` is a thin
  context/`useSyncExternalStore` binding. Keep it that way — new behavior goes
  in the class where the fake-wire tests can reach it.
- `react.ts` is deliberately JSX-free (`createElement`) so bundlers consuming
  this package as workspace SOURCE never need a JSX transform for it. Don't
  rename it to `.tsx`.
- The tui's `session.ts` is a parallel implementation of the same state
  machine — if you fix a lifecycle bug here, check whether session.ts has it
  too (and vice versa). Candidate future work: tui adopts
  `@super-harness/react/client`.
- `connect()` must stay idempotent and abandon-safe (`#client !== client`
  guard after awaits) — the provider close/connect cycle under StrictMode
  depends on it.
- Pendings lifecycle rules live in `#onTree` and are load-bearing (see the
  tests): tree settles a pending; live events only add them; `inferAsk` reads
  ONLY the last turn root; `busy = lastRoot running && !pendingAsk`.
- `ClientStore` isn't exported by `@super-line/client` — the `stores` config
  type is derived via `SuperLineClientOptions<Contract, "user">["stores"]`.
