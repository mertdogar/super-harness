# @super-harness/react

`pnpm -F @super-harness/react test` — vitest, no network: tests drive the
state machine through the `client` config option (a structural fake
super-line client + fake Store handles).

- `HarnessClient` runs in two modes, decided by the config: `url` (owned —
  connect() builds a client, close() closes it) or `client` (composition).
  A `client` **instance** is borrowed: close() detaches the tracked `on()`
  unsubscribes but never closes the host's socket. A `client` **factory** is
  owned like url (fresh per connect, closed on close) — it exists to emulate
  production ownership in tests (the StrictMode test depends on it).
  `HarnessWire` is the structural surface a borrowed client must satisfy; its
  `on` is concrete overloads on purpose — a generic breaks assignability from
  real merged-contract clients.
- `harnessClientStores()` gives hosts the `harness.node`/`harness.thread`
  client replicas to spread into their own client's `stores`.
- The reconnect poll stays in borrowed mode: rooms are per-connection and
  only this layer knows its rooms; the poll never touches the socket, so it
  cannot fight the host's reconnect logic.

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
