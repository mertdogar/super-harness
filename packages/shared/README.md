# @super-harness/shared

The isomorphic wire layer for Super Harness — safe in the browser, Bun, and
Node (no Mastra, no server dependencies). Both `@super-harness/server` and
every client import this package, making it the single source of truth for:

- **`contract`** — the super-line contract: requests (`join`, `sendMessage`,
  `resumeMessage`, `abort`, `respondToApproval`, `switchMode`, `listModes`,
  thread CRUD) and ephemeral events (`suspended`, `approvalRequired`,
  `modeChanged`, `followUpQueued`), with their zod schemas.
- **`harnessEventSchema` / `HarnessEvent`** — the enveloped node-event
  vocabulary the harness emits (message/reasoning/tool deltas, node lifecycle,
  todos, usage).
- **`apply` / `initialTree`** — the deterministic fold from events into the
  harness tree (`HarnessTree`, `NodeState`, `ThreadDoc`). `apply` mutates the
  tree in place and returns the touched node ids.
- **`subscribeTree` / `diffTree`** — the client-side Store view: open the
  thread + node Stores over a super-line client and get a live `ClientTree`.

## Install

```bash
pnpm add @super-harness/shared
```

## Version skew

The fold (`apply`) and the event vocabulary live here on purpose: server and
clients must run the **same** version of this package. An old client folding
new events (or vice versa) is undefined — deploy them together.
