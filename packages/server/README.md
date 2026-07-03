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

`close()` detaches the harness bus subscription; tear the super-line server
down by closing its transports/http server.
