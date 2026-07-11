# @super-harness/shared

The isomorphic wire layer for Super Harness — safe in the browser, Bun, and
Node (no Mastra, no server dependencies; peers are `@super-line/core` and
`zod` only). Both `@super-harness/server` and every client import this
package, making it the single source of truth for the **contract** (what
rides the wire) and the **fold** (how events become a tree). Those two are
the wire ABI: server and clients must run the **same** version of this
package — the fold is not forward-compatible across event-vocabulary changes.

## Install

```bash
pnpm add @super-harness/shared
```

## The contract plugin — `harnessContract()`

super-harness ships as a super-line **plugin**. `harnessContract()` is the
contract-time half: a `defineContractPlugin` fragment a host merges into its
own contract —

```ts
import { defineContract } from '@super-line/core'
import { harnessContract } from '@super-harness/shared'

const contract = defineContract({
  plugins: [harnessContract()],
  roles: { user: {} },
})
```

The fragment contributes:

- **Four LWW collections** — `harness.threads`, `harness.nodes`,
  `harness.tools`, `harness.membership` — with their row schemas, keys, and
  references. The runtime half (`harness()` from `@super-harness/server`)
  supplies the RLS policies and subtracts the handler keys from the host's
  `implement()` obligation.
- **The harness surface on `shared`** — requests (`harness.join`,
  `harness.sendMessage`, `harness.resumeMessage`, `harness.abort`,
  `harness.respondToApproval`, `harness.switchMode`, `harness.listModes`,
  thread CRUD) and ephemeral events: session signals (`harness.suspended`,
  `harness.approvalRequired`, `harness.modeChanged`,
  `harness.followUpQueued`) plus the token stream
  (`harness.reasoningDelta`, `harness.textDelta`,
  `harness.toolInputDelta`).

Every identifier is `harness.`-prefixed so the fragment composes beside a
host's own surface and collections without collision. `contract` is also
exported — the fragment materialized standalone with a single `user` role,
exactly as `serve()` and the tui run it. `harnessSurface` (a
`defineSurface`) types the server plugin's handlers.

Use the exported name constants (`HARNESS_THREADS`, `HARNESS_NODES`,
`HARNESS_TOOLS`, `HARNESS_MEMBERSHIP`) and helpers (`membershipId`,
`harnessThreadRoom`, `harnessResourceRoom`) — a typo'd collection or room
name is a silently dead handle.

## The four collections

The tree rides typed **collections**, not the contract's requests/events.
Structural state persists as rows; the per-token stream rides ephemeral room
events and is never persisted per-token — final strings land on the row when
the node/tool settles.

- **`harness.threads`** (`ThreadRow`) — the conversation skeleton: `turns`
  (root nodeIds), `todos`, `title`, optional `resourceId` (a sidebar-grouping
  key, decoupled from security). Thread-list reactivity is row deltas on this
  collection — there are no thread-list events.
- **`harness.nodes`** (`NodeRow`) — one row per agent node, an adjacency list
  via `parentNodeId` + `childOrder`. `reasoning`/`text` are the FINAL strings
  (written at `node_end`; empty while running). `pendingResume` parks a
  suspension's `{resumeSchema, request}` so a mid-turn reload can rebuild the
  prompt.
- **`harness.tools`** (`ToolRow`) — one row per tool call. Its own collection
  so per-token `argsText` writes never rewrite the node's blob, and so tools
  are queryable across a thread (e.g. pending approvals).
- **`harness.membership`** (`MembershipRow`) — the RLS spine: a user reads a
  thread's node/tool rows iff they hold a membership row for it. `role`
  (`viewer` | `operator`) gates control ops **per-run** — it is a row column,
  not a connection role.

## The fold — `apply()` / `initialTree()`

`HarnessEvent` is the enveloped node-event vocabulary the engine emits:
`node_start`/`node_end`, `reasoning_delta`/`text_delta`,
`tool_input_start`/`tool_input_delta`/`tool_start`/`tool_end`, `usage`,
`error`, `todo`. `apply(tree, event)` is the deterministic fold from that
stream into a `HarnessTree` of `NodeState`s — it mutates the tree in place
and returns the touched node ids, so the server-side projector knows exactly
which rows to write.

## The client view — `subscribeTree()` / `diffTree()`

`subscribeTree(client, threadId, onChange)` assembles a live `ClientTree`
from the `harness.threads`/`nodes`/`tools` collection subscriptions plus the
token-delta events. Streaming model: while a node or tool is running, its
`reasoning`/`text`/`argsText` come from the accumulated delta stream; once
the row settles, the row is authoritative and the accumulators are dropped.
It tolerates a tool row lagging its node's `toolOrder` (separate
collections), so consumers never read an absent tool.

`TreeClient` is a **structural** interface — `collection(name).subscribe()`
returning a `RowSet` plus `on(event, cb)` — deliberately looser than
`@super-line/client`'s generics. This package never imports the client, so a
client built against ANY host contract that merges `harnessContract()` fits,
and there is no multi-`@super-line/core` type skew between host and library.

`diffTree(prev, next)` is a pure snapshot diff back into the `HarnessEvent`
stream (text growth → `*_delta` of the appended suffix, a settled tool →
`tool_end`, …) for incremental consumers like the headless tui printer.
`sumUsage(nodes)` totals token usage over any subtree.

## Version skew

The contract, row schemas, event vocabulary, and fold live here on purpose:
they are one ABI. An old client folding new events (or reading new row
shapes) is undefined behavior — deploy server and clients together.
