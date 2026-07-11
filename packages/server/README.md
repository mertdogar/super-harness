# @super-harness/server

The super-line binding for a `@super-harness/core` Harness, shipped as a
super-line **plugin**. Two exports, two adoption modes:

- **`harness(engine)`** — a `SuperLinePlugin` a host adds to its own
  `createSuperLineServer` `plugins:` array. The primary story: one server, one
  socket, one auth, one collections backend for the host AND the harness.
- **`serve(engine, config)`** — the standalone host, built from the same
  pieces: it owns the collections backend, a default query-param
  `authenticate`, `identify`, and mounts `plugins: [harness(engine), ...]`.

The tree rides **collections**, not the request surface: structural state is
`harness.threads`/`nodes`/`tools`/`membership` rows (declared by
`harnessContract()` in `@super-harness/shared`), and the token stream rides
ephemeral per-thread room events that are never persisted per-token. Clients
assemble the live tree with `subscribeTree` from `@super-harness/shared` (or
`@super-harness/react`).

## Install

```bash
pnpm add @super-harness/server @super-harness/core @super-harness/shared \
  @mastra/core @super-line/core @super-line/server \
  @super-line/collections-memory @super-line/collections-sqlite
```

All `@super-line/*` packages are **peers** — your app owns one core instance
shared by host and library. What you need:

| Peer | Version | When |
| --- | --- | --- |
| `@super-line/core` | `^0.11.0` | always |
| `@super-line/server` | `^0.11.0` | always |
| `@super-line/collections-memory` | `^0.1.0` | always (serve's `memory` backend; cheap) |
| `@super-line/collections-sqlite` | `^0.1.0` | always (serve's default backend) |
| `@super-line/collections-pglite` | `^0.1.0` | **optional** — only for `storage: { type: 'pglite' }` |
| `@mastra/core` | `^1.49.0-alpha.2` | always (the engine's peer) |

A transport is the host's choice — e.g. `@super-line/transport-websocket`
(`^0.6.0`). Composing hosts that bring their own backend only need the
collections package they actually use.

## Composition — the harness as a plugin in your server

If the app runs (or should run) its own super-line server, add the harness
beside its surface. Four obligations (see `examples/composed-host` for the
runnable version, `composition.test.ts` for the e2e):

```ts
import { z } from 'zod'
import { defineContract, defineSurface } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { harnessContract } from '@super-harness/shared'
import { harness } from '@super-harness/server'

// 1. Merge the contract fragment: harnessContract() contributes the harness
//    surface (on `shared`) + the four harness.* collections.
const hostContract = defineContract({
  plugins: [harnessContract()],
  shared: defineSurface({
    clientToServer: {
      'demo.echo': { input: z.object({ text: z.string() }), output: z.object({ echoed: z.string() }) },
    },
  }),
  roles: { user: {} },
})

const srv = createSuperLineServer(hostContract, {
  transports: [webSocketServerTransport({ server: httpServer, path: '/ws' })],
  // 2. ONE collections backend, host-owned — serves the harness collections
  //    beside any of the host's own.
  collections: memoryCollections(),
  // 3. authenticate ctx carries userId (+resourceId); identify returns it.
  authenticate: (h) => ({ role: 'user' as const, ctx: { userId: userIdFrom(h) } }),
  identify: (conn) => (conn.ctx as { userId: string }).userId,
  // 4. Add the plugin. harness.* handler keys are subtracted from implement().
  plugins: [harness(engine)],
})

// The host implements only its own surface — harness.* is owned by the plugin.
srv.implement({ shared: { 'demo.echo': async ({ text }) => ({ echoed: text.toUpperCase() }) }, user: {} })
```

**`identify` is load-bearing.** The harness collections' RLS keys on
`ctx.userId`, and super-line's principal is `identify(conn) ?? conn.id` — a
random connection id. A host that skips `identify` gets a working request
surface and a **silently empty tree**: every membership-gated read is denied.
With `@super-line/plugin-auth`, `identify` comes from the session and the
identity becomes the principal for free (see `examples/auth`).

Client side: one `createSuperLineClient(hostContract)` handed to
`createHarnessClient({ client })` from `@super-harness/react` in borrowed mode — its
`close()` detaches listeners, never the host's socket.

## Standalone — `serve()`

The harness-only contract on its own server, same pieces pre-wired:

```ts
import { createServer } from 'node:http'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { serve } from '@super-harness/server'

const httpServer = createServer()
const { server, close } = await serve(engine, {
  storage: { type: 'sqlite', file: './harness.db' },   // default; 'memory' for tests
  transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
  // authenticate?: (handshake) => ({ role: 'user', ctx: { userId, resourceId? } })
  // plugin?: { roleFor, defaultRole } — membership role policy (see below)
  // plugins?: [inspector(), auth()] — extra super-line plugins beside harness()
})
httpServer.listen(4111)
```

The storage union picks the collections backend:

- `{ type: 'sqlite', file? }` — default; owns its own file. Needs
  `better-sqlite3`'s native build.
- `{ type: 'memory' }` — tests/dev.
- `{ type: 'pglite', pgUrl, electricUrl? }` — multi-node: central Postgres for
  writes + Electric-synced per-node replicas for fan-out. Loads
  `@super-line/collections-pglite` (the optional peer) on demand. Viable even
  though writes round-trip PG → Electric → replica, because tokens are
  ephemeral — only low-frequency structural rows hit the backend.

The default `authenticate` trusts `userId`/`resourceId` query params — replace
it (or compose `@super-line/plugin-auth` via `plugins:`) for anything
non-local. `close()` tears the server down and disposes the plugin's bus
subscription; the transports/http server are the caller's to close.

## What the plugin contributes

`harness(engine, opts)` returns `{ policies, handlers, setup }`:

- **Policies** — membership-based RLS over the four collections.
  `harness.nodes`/`tools` read `isIn('threadId', joinedThreads(principal))`;
  `harness.threads` reads `eq('resourceId', ctx.resourceId)` (the sidebar
  list), falling back to membership when the connection carries no
  `resourceId`; `harness.membership` reads `eq('userId', principal)`. Client
  writes are all **deny** — the plugin co-writes server-authoritatively,
  bypassing policy.
- **Handlers** — the `harness.*` requests (send/resume/abort/approve/
  switchMode/listModes/thread CRUD/join), subtracted from the host's
  `implement()`. `harness.join` adds the connection to the thread room and
  inserts a membership row.
- **`setup(ctx)`** — subscribes the engine bus. Token deltas
  (`reasoning`/`text`/`argsText`) broadcast to the per-thread room
  (`harness:thread:{id}`) — ephemeral, never persisted — and fold into a
  per-thread Projector; structural events fold through the Projector into the
  collections writer (`collectionsTreeSink`), which lands the final strings on
  the row at `node_end`/`tool_end`. Session signals (`suspended`,
  `approvalRequired`, `modeChanged`, `followUpQueued`) broadcast; a
  suspension's `{resumeSchema, request}` also parks on the node row
  (`pendingResume`) so a mid-turn reload rebuilds the prompt. Thread metadata
  persists as row updates (thread-list reactivity is `harness.threads` row
  deltas, not events); `thread_deleted` cascades node/tool/membership rows.

### Roles: viewer vs operator

The viewer/operator split is a **`role` column on `harness.membership`** —
per-user, per-thread — NOT a connection role. Control ops (send/resume/abort/
approve/switchMode/rename/delete) reject a `viewer` membership with
`FORBIDDEN`; read ops don't, so a viewer still sees the full live tree. The
default join role is `operator` (every joiner can drive — preserves
single-user behavior); pass `roleFor(ctx)` or `defaultRole` in
`HarnessPluginOptions` to hand out `viewer` memberships.

## Auth

The plugin is auth-agnostic: it reads `ctx.userId` however the host's
`authenticate` supplies it — query-param dev auth, `@super-line/plugin-auth`,
or a custom scheme. `resourceId` (optional) scopes the thread list. See
`examples/auth` for the plugin-auth pairing.
