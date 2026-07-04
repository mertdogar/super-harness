# @super-harness/web-server

The backend half of the [fullstack web example](../README.md): a super-harness
server on a [Hono](https://hono.dev) http server. It runs the `dev-server`
topology (a supervisor delegating to a weather `worker`) plus a gated
`send_report` tool so the tool-approval flow is demoable end to end, and it
serves the built React client statically when one process is all you want.

For the frontend, the multi-node docker topology, and what to try in the UI, see
the [web example README](../README.md). This file covers the server on its own.

## Run

You need `AI_GATEWAY_API_KEY` in the repo-root `.env`. In development, run the
server and the client in separate terminals:

```bash
pnpm -F @super-harness/web-server dev     # ws://localhost:4111/super-line (tsx watch)
pnpm -F @super-harness/web-client dev     # http://localhost:5173 (vite)
```

`SUPER_HARNESS_PORT` overrides the port (default 4111); `CHAT_MODEL` the gateway
model (default `anthropic/claude-haiku-4.5`).

Once you build the client (`pnpm -F @super-harness/web-client build`), the server
serves it statically, so the whole app runs as one process at
http://localhost:4111. The build check runs at boot — restart the server after
the first build.

## Storage backends

The server picks a storage backend from `SUPER_HARNESS_STORAGE` (default
`libsql`). Mastra's ground truth (threads, messages, mode) and the durable tree
Stores from `serve()` always land in the same database, so they stay in sync:

- `libsql` (default) — one `dev.db` backs both. This is the single-node dev
  path. Delete `dev.db` to reset. `dev.db` is gitignored.
- `postgres` — a Mastra `PostgresStore`; `serve()` reuses its pool, so the
  `superline_harness_*` tree tables sit beside Mastra's `mastra_*` tables in one
  central Postgres (no Electric, single fan-out). Requires `PG_URL`.
- `pglite` — central Postgres plus per-node Electric-synced replicas. This is
  the multi-node choice that the [docker topology](../README.md#multi-node-docker--store-pglite)
  boots. Requires `PG_URL`, and `ELECTRIC_URL` for live cross-node updates.

## What the server adds over dev-server

- **A gated tool.** `send_report` is registered with
  `permissions: { tools: { send_report: 'ask' } }`, so asking the supervisor to
  email a report parks an approval the client resolves with a dialog. The tool
  is deliberately fake — it exists to exercise the approval flow, not to send
  email.
- **A demo resource.** Every thread belongs to the `"web"` resource, matching
  the client's `resourceId`, so the sidebar scope, the resource room, and thread
  ownership all align. A real multi-tenant app resolves the resource per
  connection.
- **Auto-generated titles.** New threads get a short title from a
  `generateTitle` model call.
- **A libp2p presence plane.** The server builds a broker-less libp2p mesh
  (mDNS discovery, gossipsub) and passes it to `serve()` as the `adapter`. This
  plane carries only presence and inspector telemetry across nodes — the durable
  tree never touches it (Electric is the tree's own sync bus). Every node runs
  identical code and finds its peers over mDNS, so there's no node list or
  bootstrap config.

## Inspector

The server enables the super-line Control Center inspector by default: read-only
wire telemetry covering connections, requests, room broadcasts, and Store
writes. Watch it live:

```bash
pnpm -F @super-harness/web-server inspect   # Control Center against ws://localhost:4111/super-line
```

<!-- prettier-ignore -->
> [!WARNING]
> The inspector channel is unauthenticated. It's on here because this is a
> localhost dev example. Disable it with `SUPER_HARNESS_INSPECTOR=0`, and never
> ship `inspector: true` on an internet-facing node.
