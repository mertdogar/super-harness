# @super-harness/shared

`pnpm -F @super-harness/shared test` — vitest (tree fold + client view).

## Rules

- **Stay isomorphic**: no Mastra, no `@super-line/server`, no Node-only APIs.
  This package runs in browsers. Dependencies are `@super-line/core` + `zod`
  only — think hard before adding any.
- The contract, event vocabulary, and `apply` fold here are the wire ABI:
  server and clients must run the same version (no forward compatibility).
  Any event/schema change is a breaking wire change — update the fold, the
  server relay (`packages/server/src/serve.ts`), and the tui together.
- The tree rides super-line **Stores**, not the contract — don't add tree
  payloads to requests/events.
- Store `data` is untyped on the wire (`unknown`); `subscribeTree`/`diffTree`
  assert the shape. Keep hard typed gates in the contract's requests instead.
