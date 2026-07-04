# @super-harness/server

The super-line binding for a `@super-harness/core` Harness. `serve(harness,
config)` exposes an existing (transport-free) Harness over a super-line
WebSocket server:

- **Tree over Stores** — raw node events fold through a per-thread Projector
  into `superlineTreeSink`, which writes per-node and per-thread super-line
  Store documents. Clients read the live tree by opening Stores (see
  `subscribeTree` in `@super-harness/shared`) — the tree never rides the
  request/response contract.
- **Contract 1:1** — `harness.sendMessage`, `harness.resumeMessage`,
  `harness.abort`, `harness.respondToApproval`, `harness.switchMode`,
  `harness.listModes`, thread CRUD each map onto the corresponding Harness
  method.
- **Ephemeral signals** — `harness.suspended`, `harness.approvalRequired`,
  `harness.modeChanged`, `harness.followUpQueued` broadcast to the
  `harness:thread:{id}` room.
- **Composable** — `serve()` is a thin standalone host over `harnessStores()`
  and `mountHarness()`; a host app with its own super-line server merges
  `harnessSurface` into its contract's `shared` block and spreads the stores
  and handlers into its own config (see "Composition" below).

## Install

```bash
pnpm add @super-harness/server @super-harness/core @mastra/core
```

## Use

```ts
import { createServer } from 'node:http'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { serve } from '@super-harness/server'

const httpServer = createServer()
const { server, close } = await serve(harness, {
  storage: { type: 'sqlite', path: './harness.db' },   // default; 'memory' for tests
  transports: [webSocketServerTransport({ server: httpServer, path: '/super-line' })],
  // authenticate?: (handshake) => ({ role: 'user', ctx: { userId } })
  // inspector?: true — super-line Control Center telemetry (read-only but
  // UNAUTHENTICATED; dev/trusted networks only). Must ALSO be set on the WS
  // transport. View: npx @super-line/control-center --url ws://localhost:4111/super-line
})
httpServer.listen(4111)
```

The sqlite backend uses one table per namespace (`harness_node`,
`harness_thread`) and needs `better-sqlite3`'s native build (in this workspace
it's allowlisted via `allowBuilds` in `pnpm-workspace.yaml`). The default
`authenticate` trusts a `userId` query param — replace it for anything
non-local.

### Composition — mounting into a host super-line server

If the app already runs its own super-line server, mount the harness beside
its surface instead of calling `serve()` — one server, one socket, one auth:

```ts
import { defineContract, mergeSurfaces } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { harnessSurface } from '@super-harness/shared'
import { harnessStores, mountHarness } from '@super-harness/server'

const contract = defineContract({
  // must ride `shared`: rooms only broadcast shared events
  shared: mergeSurfaces(harnessSurface, appSurface),
  roles: { user: {} },
})
const srv = createSuperLineServer(contract, {
  transports,
  authenticate,                                  // ctx must extend { userId, resourceId? }
  identify: (conn) => (conn.ctx as { userId: string }).userId, // store ACLs key on it
  stores: { ...(await harnessStores({ type: 'postgres', db })), ...appStores },
})
const mount = mountHarness(srv, harness)
srv.implement({ shared: { ...mount.handlers, ...appHandlers }, user: {} })
```

`identify` is load-bearing: without it the store principal is the random
connection id and every tree read is silently denied. See
`examples/composed-host` for the runnable version, including the client side
(one shared `createSuperLineClient` + `createHarnessClient({ client })`).

### Sharing the app's database (libsql / postgres)

If the app already owns a database — e.g. the one Mastra's memory writes to —
`serve()` can write its tree Stores into `superline_harness_node` /
`superline_harness_thread` tables in that **same** database instead of a
separate `harness.db`. Pass the live connection the app already built (no
second pool, no `better-sqlite3`):

```ts
// libsql — pass the SAME @libsql/client you give LibSQLStore({ client })
const client = createClient({ url: 'file:./app.db' })   // or a libsql:// URL
new LibSQLStore({ id: 'app', client })                  // Mastra memory
await serve(harness, { storage: { type: 'libsql', client }, transports })

// postgres — PostgresStore exposes its pg-promise handle as `storage.db`
const storage = new PostgresStore({ id: 'app', connectionString })
await serve(harness, { storage: { type: 'postgres', db: storage.db }, transports })
```

Both are last-writer-wins whole-doc replaces (same model as the sqlite backend,
which the server is the sole writer of). The bindings are typed against
structural subsets of the drivers, so `@super-harness/server` imports neither
`@libsql/client` nor `pg-promise` — the app owns those. `libsqlStoreServer` /
`pgStoreServer` are also exported directly if you want to open a Store yourself.

### Multi-node (Postgres + Electric)

For a horizontally-scaled deployment where Postgres + Electric are already the
fan-out infra, use `@super-line/store-pglite` (an **optional peer** — install it
only for this backend): central Postgres for writes/reads/ACL, per-node
Electric-synced PGlite replicas whose `live.changes` feed drives the client
fan-out.

```ts
// share the Postgres URL your app already uses; point at the Electric shape API
await serve(harness, {
  storage: { type: 'pglite', pgUrl: process.env.DATABASE_URL, electricUrl: 'http://electric:3000/v1/shape' },
  transports,
})
```

The tree lands in `superline_node` / `superline_thread` tables. Live updates
require an Electric service in front of the Postgres — a write round-trips
central PG → Electric → every node's replica → `onChange`. Because the sink
persists whole node docs on a **trailing debounce** (see below), a fast token
stream lands ≤ 1 write per `flushMs` (default 150 ms) rather than one per token.

`close()` detaches the harness bus subscription; tear the super-line server
down by closing its transports/http server.
