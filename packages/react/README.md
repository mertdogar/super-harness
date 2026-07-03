# @super-harness/react

Headless React client for a super-harness server. Ships the hard part — the
wire state machine — and no pixels: bring your own components (the
`examples/web/client` app shows a full shadcn/ai-elements UI on top).

- **`HarnessClient`** (framework-free, also at `@super-harness/react/client`) —
  connects over super-line, joins a thread, assembles the live tree via
  `subscribeTree`, and derives the session state: `busy`, `pendingAsk`
  (ask_user suspensions — including re-inferring one from the durable tree
  after a refresh), `pendingApproval`, modes, threads, follow-up queue depth.
- **`HarnessProvider` / `useHarness()` / `useHarnessClient()`** — context +
  `useSyncExternalStore` bindings. The provider owns connect/close.

## Use

```tsx
import { createHarnessClient, HarnessProvider, useHarness, useHarnessClient } from "@super-harness/react"

const client = createHarnessClient({
  url: "ws://localhost:4111/super-line",
  params: { userId: "me" },        // read by the server's authenticate
  threadId,                        // full 21-char nanoid — never truncate
})

<HarnessProvider client={client}><App /></HarnessProvider>

function Composer() {
  const state = useHarness()        // reactive HarnessState
  const client = useHarnessClient() // actions
  return state.pendingAsk
    ? <Reply onSubmit={(t) => client.reply(t)} question={state.pendingAsk.request} />
    : <Input disabled={!state.connected} onSubmit={(t) => client.send(t)} busy={state.busy} onStop={() => client.abort()} />
}
```

Actions: `send`, `reply`, `respond(decision)`, `dismissAsk`, `abort`,
`setMode`, `switchThread`, `newThread`, `deleteThread`, `refreshModes`,
`refreshThreads`.

## Semantics worth knowing

- `busy` is derived from the tree's LAST turn root — and reads `false` while
  an ask_user suspension is parked (the server is waiting on the user).
- `reply` keeps the prompt and sets `notice` when the server rejects the
  resume (`ok: false`) — answers are never silently dropped. `dismissAsk()` is
  the local escape hatch for a prompt the server no longer knows about.
- `abort()` clears busy/pendings/queue locally as well — mirror of what the
  server just did.
- Render the tree from `state.tree` (`ClientTree` from `@super-harness/shared`);
  a delegation is a CHILD NODE (`childOrder` + `textOffset`), not a tool entry.
- Reconnects re-join and re-subscribe automatically (1s connectivity poll).
