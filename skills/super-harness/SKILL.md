---
name: super-harness
description: Integrate the super-harness multi-agent runtime (a Mastra supervisor Agent delegating to subagent Agents, with full-fidelity streaming, HITL approvals/suspensions, per-thread modes, and thread management) into a project. Use when embedding createHarness in a backend, exposing a harness over WebSockets with serve(), building a client on the wire contract + subscribeTree, or wiring tool approvals, ask_user suspensions, modes, or threads.
---

# super-harness

Three packages, one direction of dependency:

- **`@super-harness/core`** — the engine. `createHarness({ supervisor, subagents })`
  hosts a tree of Mastra Agents. Transport-free: you talk to a `Harness` object
  and subscribe to its event bus. `@mastra/core` is a **peer dep**.
- **`@super-harness/server`** — `serve(harness, config)` exposes that Harness over
  a super-line WebSocket: tree state rides durable Stores, session signals ride
  events, requests map onto Harness methods (`join` alone is transport-level:
  room membership + Store grants).
- **`@super-harness/shared`** — isomorphic wire layer both sides import: the
  contract, the event vocabulary, the tree fold (`apply`), and the client view
  (`subscribeTree`). Never re-declare these types.

## Mental model

One `Harness` = one supervisor + registered subagents + per-thread session state.
Everything observable flows through **one bus**:
`harness.subscribe((threadId, event) => …)` — raw node events (text/reasoning/
tool deltas at every delegation depth) plus session events (`suspended`,
`approval_required`, `mode_changed`, `follow_up_queued`, thread CRUD,
`tree_changed`). A `Projector` folds node events into a `HarnessTree`
(`harness.getTree(threadId)`), so you rarely handle raw deltas yourself.

Turns are per-thread and serialized: `sendMessage` during a running turn
**queues**; `steer` aborts and replaces. `ask_user` (built-in, root-only)
suspends a turn → `resume` continues it. A gated tool call suspends via
Mastra's approval flow → `respondToApproval` continues it.

## Quick start (embedded, no transport)

```ts
import { Agent } from '@mastra/core/agent'
import { createHarness } from '@super-harness/core'

const harness = createHarness({
  supervisor,                                   // Agent — delegatesTo defaults to ALL subagents
  subagents: [{ agent: worker }],               // Agents — delegatesTo defaults to none (leaf)
  memory,                                       // optional ThreadStore (a MastraMemory fits) → threads + mode persistence
  generateTitle: true,                          // optional — auto-title from the first message (needs memory)
  modes: [{ id: 'chat', instructions: '…', metadata: { default: true } }],
  permissions: { tools: { deploy: 'ask' } },    // gate supervisor tool calls
})

harness.subscribe((threadId, e) => {
  if (e.type === 'tree_changed') render(e.tree)
  if (e.type === 'approval_required') promptUser(threadId, e)
})

const res = await harness.sendMessage({ threadId: 't1', content: 'hi' })
// res.status: 'done' | 'suspended' | 'error' | 'queued'
```

Serve it remotely and connect a client: see [INTEGRATION.md](INTEGRATION.md).
Full worked examples (server, web client, HITL round-trips): see [EXAMPLES.md](EXAMPLES.md).

## Rules

- **ALWAYS** give agents `memory` if you want conversation recall across turns
  and `--thread` resume — the harness passes `{ thread, resource }` to Mastra,
  but recall is the Agent's memory doing the work.
- **ALWAYS** run the same `@super-harness/shared` version on server and client —
  the contract AND the tree fold are the wire ABI; there is no forward compat.
- **ALWAYS** keep `@mastra/core` versions in lockstep across your app, core's
  peer range, and server (currently `1.49.0-alpha.2`).
- **ALWAYS** treat approvals/`ask_user` as **root-only**: subagents run headless
  to completion. Don't hand a subagent a tool that needs human sign-off; put it
  on the supervisor.
- **PREFER** reading `tree_changed` / `getTree` over folding raw node events
  yourself; drop to raw deltas only for token-level streaming UI.
- **PREFER** explicit `delegatesTo` edges over `true` (everyone) — an off-edge
  delegation is rejected at spawn time with an error tool result, and
  `maxDepth` (default 3) is the backstop, not the design.
- **NEVER** put tree payloads on the contract — the tree rides Stores;
  requests/events are for actions and ephemeral signals.

## Pitfalls

- `sendMessage` returning `{ status: 'queued' }` is success, not an error — the
  turn runs after the current one; don't client-side-block sends mid-turn.
- Built-ins (`delegate`, `ask_user`, `todo`) never gate and can't be hidden by a
  mode's `availableTools` (they're unioned back in). Per-tool `deny` beats yolo;
  an unmatched tool falls back to `ask` **once gating is armed** — which happens
  when `permissions` OR `toolCategoryResolver` is configured; with neither,
  nothing gates.
- `respondToApproval`/`resume` with no `toolCallId` only works when exactly one
  is parked — pass the id from the event when handling concurrent suspensions.
- `abort()` also clears the follow-up queue and resolves pending gates as
  aborted — an approval answered after abort does not resurrect the turn.
- Mode `instructions` LAYER onto the supervisor's own instructions (string
  concat) — but only when the agent's instructions are a plain string;
  structured instruction shapes are dropped and the mode text runs alone.
- Thread ids: full 21-char nanoids. Never truncate them in UIs — a prefix
  silently creates a fresh thread on resume.
- Thread-list events are per-**resource**, not per-thread: `thread_created`/
  `thread_renamed`/`thread_deleted` broadcast to `resource:{id}` (from the
  connection's `resourceId`, falling back to `resourceFor`/the threadId), so a
  tab viewing thread A still sees thread B appear. A connection with no
  `resourceId` lists ALL threads and shares the userId-keyed room — fine for a
  single-tenant tui, wrong for multi-user. Scoping is opt-in for backward compat.
- `generateTitle` surfaces as a `thread_renamed` after the first turn settles —
  not a separate title event. Custom `instructions` must state the reply IS the
  title, or a chat model answers the message instead of naming it.
