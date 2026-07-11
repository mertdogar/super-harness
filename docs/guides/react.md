---
title: Use the React client
---

# Use the React client

`@super-harness/react` is headless. It owns the wire state machine and leaves
rendering to your application.

```tsx
const client = createHarnessClient({
  url: 'ws://localhost:4111/super-line',
  params: { userId: 'me', resourceId: 'me' },
  threadId,
})

<HarnessProvider client={client}><App /></HarnessProvider>
```

Use `useHarness()` for reactive session state and `useHarnessClient()` for
actions such as `send`, `reply`, `respond`, `abort`, and `switchThread`.
