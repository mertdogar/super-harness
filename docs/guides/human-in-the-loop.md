---
title: Human-in-the-loop controls
---

# Human-in-the-loop controls

Super Harness makes human input part of a durable session, rather than a UI
side channel. The root agent can call `ask_user`, and protected tools can pause
for an approval decision.

Configure tool permissions when you create the harness.

```ts
const engine = createHarness({
  supervisor,
  permissions: { tools: { deploy: 'ask', delete_data: 'deny' } },
})
```

Clients receive suspension and approval signals, then call `reply()` or
`respond()` through `HarnessClient`. A refresh reconstructs a pending question
from the durable node row.
