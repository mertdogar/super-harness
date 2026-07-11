# @super-harness/shared

`pnpm -F @super-harness/shared test` — vitest (tree fold + client view).

## Rules

- **Stay isomorphic**: no Mastra, no `@super-line/server`, no Node-only APIs.
  This package runs in browsers. Dependencies are `@super-line/core` (a
  **peer**, ≥0.10.1 for `defineContractPlugin` + the collection query helpers
  `eq`/`isIn`) + `zod` only — think hard before adding any.
- The contract is exported as **`harnessContract()`** — a `defineContractPlugin`
  fragment a host merges via `defineContract({ plugins: [harnessContract()] })`.
  It contributes the four `harness.*` COLLECTIONS (`threads`/`nodes`/`tools`/
  `membership`) + the harness surface on `shared` (requests + events, incl. the
  ephemeral token-delta events). `harnessSurface` (a `defineSurface`) is also
  exported to type the server's `harness()` plugin; `contract` materializes the
  fragment standalone for `serve()`/tui. Use the exported collection-name
  constants (`HARNESS_NODES`, …) + room helpers — a typo is a dead handle.
- The contract, event vocabulary, row schemas, and `apply` fold here are the
  wire ABI: server and clients must run the same version (no forward
  compatibility). Any change is breaking — update the fold, the server writer,
  and the clients together.
- **The tree rides COLLECTIONS**, not the contract's requests/events. Structural
  state is rows; the token stream (reasoning/text/argsText deltas) rides
  ephemeral room EVENTS and is never persisted per-token — the final strings
  land on the row at `node_end`/`tool_end` (streaming model c).
- `subscribeTree(client, threadId, onChange)` assembles the tree from the
  `harness.nodes`/`tools`/`threads` collection subscriptions + the token-delta
  events (a running node's text comes from the accumulated deltas; a settled row
  is authoritative). `diffTree`/`sumUsage` are pure over `ClientTree` and
  tolerate a tool row lagging its node's `toolOrder`.
- Collection row `data` is validated by the server against the schema; the
  client asserts `RowOf` shapes. Keep hard typed gates in the contract requests.
