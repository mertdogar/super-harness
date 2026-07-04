# @super-harness/shared

`pnpm -F @super-harness/shared test` — vitest (tree fold + client view).

## Rules

- **Stay isomorphic**: no Mastra, no `@super-line/server`, no Node-only APIs.
  This package runs in browsers. Dependencies are `@super-line/core` (a
  **peer**, ≥0.9 for `defineSurface`) + `zod` only — think hard before adding
  any.
- The contract is exported two ways: `harnessSurface` (the composable
  fragment a host merges into its **shared** block — it must ride `shared`,
  not a role, because rooms only broadcast shared events) and `contract` (the
  fragment mounted standalone for `serve()`/tui). Every identifier is
  `harness.`-prefixed: requests/events `harness.*`, store namespaces
  `HARNESS_NODE_STORE`/`HARNESS_THREAD_STORE`, rooms via
  `harnessThreadRoom()`/`harnessResourceRoom()` — use the exported
  constants/helpers, a typo'd store name is a silently dead handle.
- The contract, event vocabulary, and `apply` fold here are the wire ABI:
  server and clients must run the same version (no forward compatibility).
  Any event/schema change is a breaking wire change — update the fold, the
  server relay (`packages/server/src/serve.ts`), and the tui together.
- The tree rides super-line **Stores**, not the contract — don't add tree
  payloads to requests/events.
- Store `data` is untyped on the wire (`unknown`); `subscribeTree`/`diffTree`
  assert the shape. Keep hard typed gates in the contract's requests instead.
