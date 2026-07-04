# web example

The fullstack showcase: a super-harness backend on Hono and a React frontend
(Vite + Tailwind + shadcn/ui + ai-elements) that renders the live agent tree —
streaming text and reasoning, recursive subagent activity, tool-approval
dialogs, ask_user replies, modes, and threads.

```
examples/web/
├── server/   @super-harness/web-server — createHarness + serve() on a Hono http server
└── client/   @super-harness/web-client — Vite React app over @super-harness/react (headless client) + shadcn/ai-elements UI
```

## Run

```bash
pnpm -F @super-harness/web-server dev    # ws://localhost:4111/super-line (needs AI_GATEWAY_API_KEY in root .env)
pnpm -F @super-harness/web-client dev    # http://localhost:5173
```

Build the client (`pnpm -F @super-harness/web-client build`) and the server
serves it statically — one process at http://localhost:4111. The dist check
runs at boot, so restart the server after the first build.

By default (`SUPER_HARNESS_STORAGE` unset → `libsql`) both Mastra's memory and
the durable tree land in one `dev.db`. The other two modes point at a central
Postgres — see below.

## Multi-node (docker + store-pglite)

`docker-compose.yml` boots the full multi-node topology that end-to-end verifies
`@super-line/store-pglite`: central **Postgres** + **Electric**, **3 nodes**, a
**vite** frontend, and the super-line **Control Center**.

```bash
docker compose up --build      # needs AI_GATEWAY_API_KEY in the repo-root .env
```

One central Postgres holds **both** ground truths — Mastra's `mastra_*`
(threads/messages/mode, via `@mastra/pg`) and super-line's
`superline_node`/`superline_thread` (the tree). Electric streams the tree tables
into each node's in-memory **PGlite replica**; Mastra reads/writes central PG
directly. So any node sees the same threads and streams the same tree.

Open **http://localhost:5173** and pick the node from the **selectbox in the
header** (node-1/2/3 → `ws://localhost:8801‑8803`; the selectbox appears because
the frontend container sets `VITE_NODE_BASE_PORT`). To see the store-pglite proof
in one window: drive a conversation on **node-1**, then flip the selectbox to
**node-2** — the client reconnects and the *same* thread re-renders from node-2's
replica. That round-trip (`node-1 → Postgres → Electric → node-2`) **is** the
proof. (Node and thread aren't in the URL; resume a past thread from the sidebar —
threads are central-Postgres-backed, so every node lists them all.)

The **Control Center** on http://localhost:8081 connects to node-1, but a
separate broker-less libp2p/mDNS mesh (independent of the Electric store bus)
carries presence + inspector traffic cluster-wide — so that one connection
already surfaces all three nodes, no repointing needed.

Switch backends with `SUPER_HARNESS_STORAGE`: `pglite` (compose default),
`postgres` (central PG, no Electric — super-line reuses Mastra's pool), or
`libsql` (single-node dev). `postgres`/`pglite` require `PG_URL`; `pglite` also
`ELECTRIC_URL`.

> If the image build fails on `better-sqlite3` (a transitive dep pulled in by the
> sqlite Store backend, unused here), the base image needs build tools — add
> `python3 make g++` to `Dockerfile` before `pnpm install`.

## Inspector (super-line Control Center)

The server runs with the super-line inspector enabled (read-only wire
telemetry: connections, requests, room broadcasts, Store writes). Watch it
live:

```bash
pnpm -F @super-harness/web-server inspect   # opens the Control Center against ws://localhost:4111/super-line
```

The inspector channel is **unauthenticated** — it's on here because this is a
localhost dev example. Disable with `SUPER_HARNESS_INSPECTOR=0`, and never
ship `inspector: true` on an internet-facing node.

## What to try

- **Delegation**: ask a weather question — the supervisor delegates to the
  worker; its stream renders nested inside the supervisor's turn.
- **Approval**: "send me a report of this by email" — `send_report` is gated
  (`permissions: { tools: { send_report: 'ask' } }`), a dialog asks you to
  approve/decline/always-allow.
- **Suspension**: the supervisor may `ask_user` — the composer switches to
  reply mode.
- **Refresh mid-turn**: the tree rides a durable sqlite Store; a reload
  rebuilds the full transcript, user messages included.
- **Modes / threads**: switch chat ↔ terse in the header; threads persist in
  the sidebar (LibSQL-backed Mastra memory).
