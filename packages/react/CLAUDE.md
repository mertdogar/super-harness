# @super-harness/react

`pnpm -F @super-harness/react test` — vitest, no network: tests drive the state
machine through the `client` config option (a structural fake super-line client
with fake collections + room-event `on`/`emit`).

- `HarnessClient` runs in two modes: `url` (owned — connect() builds a client,
  close() closes it) or `client` (composition, borrowed — close() detaches the
  tracked `on()` unsubscribes but never closes the host's socket). A `client`
  **factory** is owned like url (fresh per connect) — the StrictMode test needs
  it. `HarnessWire` is the structural surface a borrowed client must satisfy; its
  `on`/`collection` are concrete (not generic) so assignability from real
  merged-contract clients holds.
- **No Store replicas** — `harnessClientStores()` is gone. The tree rides the
  built-in `client.collection()` (nothing to configure). `subscribeTree` (from
  `@super-harness/shared`) drives the node/tool/thread collection subscriptions +
  token-delta events.
- **The sidebar rides a `harness.threads` collection subscription** — rows ARE
  the list, deltas are the reactivity. There's no `refreshThreads`/thread-list
  events anymore; a delete of the ACTIVE thread flips `activeThreadDeleted`
  (detected by the active row vanishing from the sidebar). `#onThreads` maps rows
  → `ThreadInfo` sorted newest-updated first.
- The reconnect poll stays in borrowed mode (rooms are per-connection; only this
  layer knows its rooms); it re-joins + re-subscribes tree AND threads.
- `harness-client.ts` is the engine; `react.ts` is a thin
  context/`useSyncExternalStore` binding (deliberately JSX-free — don't rename to
  `.tsx`). New behavior goes in the class where the fake-wire tests reach it.
- The tui's `session.ts` is a parallel implementation of the same state machine —
  fix lifecycle bugs in both.
- `connect()` must stay idempotent + abandon-safe (`#epoch` guard after awaits) —
  the provider close/connect cycle under StrictMode depends on it.
- Pendings lifecycle rules live in `#onTree` and are load-bearing (see tests):
  the tree settles a pending; live events only add them; `inferAsk` reads ONLY
  the last turn root and tolerates a tool row lagging `toolOrder`;
  `busy = lastRoot running && !pendingAsk`.
