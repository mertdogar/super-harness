# Integration patterns

Pick by where your consumers are:

| Pattern | Use when | You import |
| --- | --- | --- |
| **A. Embedded** | harness lives inside your process (backend job, CLI, tests) | `core` only |
| **B. Hosted** | remote/multiple clients, durable tree, live viewers | `core` + `server` |
| **C. Custom client** | your own web/TUI frontend against a hosted harness | `shared` + `@super-line/client` |

## A. Embedded (core only)

No transport, no super-line. Construct agents, `createHarness`, subscribe, send.

- Read results from the returned `SendResult` and state from
  `harness.getTree(threadId)`; subscribe for streaming/HITL signals.
- Handle `suspended` (ask_user) by calling
  `harness.resume({ threadId, toolCallId, resumeData })`, and
  `approval_required` by calling
  `harness.respondToApproval({ threadId, toolCallId, decision, message? })`
  with `'approve' | 'decline' | 'always_allow' | 'always_allow_category'`.
- Tests: the engine is fake-driveable — see
  `packages/core/src/harness/harness.test.ts` for the fake-runner pattern
  (no network, no Mastra model calls).

## B. Hosted (serve)

```ts
import { createServer } from 'node:http'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { serve } from '@super-harness/server'

const httpServer = createServer()
const { server, close } = await serve(harness, {
  storage: { type: 'sqlite', path: './harness.db' },   // default; 'memory' = non-durable (tests/dev)
  transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
  authenticate: (h) => ({ role: 'user', ctx: { userId: verify(h), resourceId } }),
})
httpServer.listen(4111)
```

- The default `authenticate` trusts `userId` (and optional `resourceId`) query
  params — replace it for anything beyond localhost. `resourceId` is the
  thread-list scope: connections that share one get a scoped `listThreads` +
  server-pinned `createThread`, and join the same resource room so
  `threadCreated`/`threadRenamed`/`threadDeleted` reach all their tabs. Omit it
  (as the tui/dev-server do) for the unscoped, list-all default.
- sqlite storage owns its own file and needs `better-sqlite3`'s native build —
  allowlist it for your package manager (pnpm: `allowBuilds` in
  `pnpm-workspace.yaml`, or `pnpm approve-builds`).
- To reuse a database the app already has (no second file, no native build),
  pass the live connection: `storage: { type: 'libsql', client }` (the same
  `@libsql/client` you give `LibSQLStore`) or `storage: { type: 'postgres', db }`
  (`PostgresStore`'s public `storage.db`). The tree lands in `superline_node` /
  `superline_thread` tables beside the app's own. For multi-node, `storage:
  { type: 'pglite', pgUrl, electricUrl }` keeps each node's replica in sync via
  central Postgres + Electric (the optional `@super-line/store-pglite` peer).
- What goes where: tree state → per-node/per-thread **Stores**; content signals
  (`suspended`, `approvalRequired`, `modeChanged`, `followUpQueued`) → room
  events on `thread:{id}`; thread-list signals (`threadCreated`, `threadRenamed`,
  `threadDeleted`) → room events on `resource:{id}`; actions → contract requests.
  `close()` only detaches the bus subscription; close the http server to tear
  down.

## C. Custom client

**React apps: use `@super-harness/react` instead of hand-rolling this** —
`createHarnessClient({ url, params, threadId })` + `<HarnessProvider client>` +
`useHarness()`/`useHarnessClient()` wrap the pattern below (join, subscribeTree,
ask/approval lifecycle, reconnect). The raw wiring:

The contract lives in `@super-harness/shared` — import it, never redeclare.

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryStoreClient } from '@super-line/store-memory'
import { contract, subscribeTree } from '@super-harness/shared'

const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'ws://…/super-line?userId=me' }),
  role: 'user',
  stores: { node: memoryStoreClient(), thread: memoryStoreClient() },
})

await client.join({ threadId })                        // FIRST — grants the Stores
const stop = subscribeTree(client, threadId, (tree) => render(tree))
client.on('approvalRequired', (e) => askHuman(e))      // then respondToApproval(...)
await client.sendMessage({ threadId, message: 'hi' })
```

- `join` before `subscribeTree`: Stores are deny-by-default; join creates the
  thread Resource and grants your user (including nodes from before you joined).
- Requests: `join`, `sendMessage`, `resumeMessage`, `abort`, `respondToApproval`,
  `switchMode`, `renameThread`, `deleteThread` return `{ ok }` — `ok: false`
  means the harness rejected it (e.g. resume on a running thread); surface it,
  don't retry. The reads return data instead: `listModes` →
  `{ modes, defaultModeId? }`, `listThreads` → `{ threads }`, `createThread` →
  `{ threadId }`.
- For token-level rendering, diff snapshots with `diffTree(prev, next)` instead
  of re-rendering whole trees.
- Server→client events via `client.on(...)`: `suspended`, `approvalRequired`,
  `modeChanged`, `followUpQueued` (thread-scoped — need a `join`), plus
  `threadCreated`/`threadRenamed`/`threadDeleted` (resource-scoped — they arrive
  without a join, so a sidebar reacts to sibling tabs). `renameThread` and
  auto-titling both surface as `threadRenamed`.

## Topology design

- Edges are ids: `subagents: [{ agent: researcher, delegatesTo: ['browser'] }]`.
  Supervisor default = all subagents; subagent default = leaf; `true` = everyone
  (cycles allowed — `maxDepth`, default 3, is the terminator).
- `recall: true` on a subagent gives it thread memory recall; leave it off for
  stateless workers. `maxSteps` caps a subagent's tool loop.
- The allowed-target list is enforced when a delegation spawns (an off-edge
  `agentType` gets an error tool result, which the model sees and can correct),
  and `createHarness` throws on unregistered ids at construction.

## Permissions & approvals design

- Start with categories via `toolCategoryResolver` (`'read' | 'edit' | 'execute'
  | 'mcp' | 'other'`) + `permissions.categories`, then pin exceptions in
  `permissions.tools`. Precedence: per-tool `deny` > yolo > other per-tool
  policies > session grants > category > `ask` fallback.
- `always_allow` / `always_allow_category` decisions become **session grants**
  (per thread, in-memory) — they don't persist across restarts.
- `harness.setYolo(threadId, true)` for a trusted-operator mode; per-tool `deny`
  still wins.

## Modes & threads

- A mode = instruction overlay + optional `availableTools` allowlist, applied to
  **supervisor turns only**. Persisted per thread as `harnessModeId` in thread
  metadata when `memory` is configured; `metadata: { default: true }` (or
  `defaultModeId`) picks the default.
- `memory` is any structural `ThreadStore` — a `new Memory(...)` from
  `@mastra/memory` fits directly. `resourceFor(threadId)` maps threads to your
  own user/tenant key (default: each thread is its own resource — the
  resourceId falls back to the threadId). That resourceId is the thread-list
  scope end to end: it filters `listThreads`, pins `createThread`, and keys the
  resource room the thread-list events broadcast to. An **implicit** first-
  message thread (created mid-turn by Mastra, not via `createThread`) inherits
  its resourceId from `resourceFor` — leave that at the default and its
  create/delete broadcasts land in a per-thread room no other tab is in, so set
  `resourceFor` to your real tenant key for cross-tab sync to work.
- `generateTitle: true` (or `{ model?, instructions? }`) auto-titles a thread
  from its first message once the turn settles — it relays as a `threadRenamed`,
  so no extra client wiring. Custom `instructions` MUST tell the model the reply
  IS the title verbatim, or a chat model answers the message instead of naming
  it.
