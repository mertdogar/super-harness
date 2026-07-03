# @super-harness/server

The super-line binding for a `@super-harness/core` Harness. `serve(harness,
config)` exposes an existing (transport-free) Harness over a super-line
WebSocket server:

- **Tree over Stores** — raw node events fold through a per-thread Projector
  into `superlineTreeSink`, which writes per-node and per-thread super-line
  Store documents. Clients read the live tree by opening Stores (see
  `subscribeTree` in `@super-harness/shared`) — the tree never rides the
  request/response contract.
- **Contract 1:1** — `sendMessage`, `resumeMessage`, `abort`,
  `respondToApproval`, `switchMode`, `listModes`, thread CRUD each map onto
  the corresponding Harness method.
- **Ephemeral signals** — `suspended`, `approvalRequired`, `modeChanged`,
  `followUpQueued` broadcast to the `thread:{id}` room.

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

The sqlite backend uses one table per namespace (`node`, `thread`) and needs
`better-sqlite3`'s native build (in this workspace it's allowlisted via
`allowBuilds` in `pnpm-workspace.yaml`). The default `authenticate`
trusts a `userId` query param — replace it for anything non-local.

### Sharing the app's database (libsql / postgres)

If the app already owns a database — e.g. the one Mastra's memory writes to —
`serve()` can write its tree Stores into `superline_node` / `superline_thread`
tables in that **same** database instead of a separate `harness.db`. Pass the
live connection the app already built (no second pool, no `better-sqlite3`):

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

`close()` detaches the harness bus subscription; tear the super-line server
down by closing its transports/http server.
