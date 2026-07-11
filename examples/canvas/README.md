# canvas example

The CRDT/cluster flagship: a harness supervisor as a **first-class co-writer on
a shared CRDT canvas**. You drag labelled squares on a board; you ask the agent
("add three blue squares in a row, then delete the red one") in a harness chat
thread beside it — and its tool calls land on the **same scene document you're
dragging**, merging live with your edits. Multi-board lobby, an approval-gated
`clear_board`, and an optional 2-node docker cluster where the same boards,
scenes, and threads converge over Postgres + Electric.

```
examples/canvas/
├── shared/   @super-harness/canvas-shared — the merged contract (harnessContract() + boards/scenes) and the scene schema
├── server/   @super-harness/canvas-server — supervisor + canvas tools over a server-side CrdtServerReplica
└── client/   @super-harness/canvas-client — Vite React: boards lobby (TanStack DB) + CRDT board + harness chat, one socket
```

## What it demonstrates

- **The harness agent as a CRDT co-writer.** The chat is an ordinary harness
  thread (streaming tree, `@super-harness/react`), but every supervisor tool
  (`add_shape` / `move_shape` / `restyle_shape` / `delete_shape` /
  `clear_board`) opens a server-side `CrdtServerReplica` over the board's
  canonical scene doc and applies one Store primitive (`update` merges,
  `delete(['shapes', id])` surgically removes), stamped `origin: 'agent'`.
  Agent edits and your drags are concurrent writers on the same `document`-mode
  CRDT — different shapes/fields merge, nothing clobbers, even mid-drag.
- **HITL on a destructive canvas op.** `clear_board` is approval-gated
  (`permissions: { tools: { clear_board: 'ask' } }`): the model calls it, the
  turn parks, an approval dialog pops in the client, and only your approve lets
  it wipe the board (per-shape `delete(path)`, never a whole-doc set).
- **Typed rows and CRDT docs on one contract.** `boards` is an LWW row
  collection under deny-by-default RLS (world-readable; only the creator
  principal may rename/delete), driven client-side as an **optimistic TanStack
  DB collection** — insert/rename/delete apply instantly and a policy rejection
  rolls back with a notice. `scenes` is a CRDT document collection, one doc per
  board, coupled to the lobby via the backend change feed (insert a board row →
  the server creates its scene doc; delete → the doc delete fans out to open
  handles).
- **Everything on one socket.** One super-line client carries the boards rows,
  the scene doc deltas, AND the harness surface; the harness client BORROWS it
  (`createHarnessClient({ client })`).
- **2-node convergence over Postgres + Electric, no adapter.** In docker, both
  row collections (`collections-pglite`) and CRDT docs (`collections-crdt-pglite`)
  ride a central Postgres streamed by Electric into each node's in-memory
  PGlite replica. Edit a board on node-1, flip the header selectbox to node-2:
  the same scene — and the same harness thread — re-render from node-2's
  replica. A separate broker-less **libp2p mesh** (mDNS discovery) carries
  presence + inspector, so the Control Center sees the whole cluster from one
  connection.

## Run (local, memory mode)

```bash
pnpm -F @super-harness/canvas-server dev    # ws://localhost:4116/super-line (needs AI_GATEWAY_API_KEY in root .env)
pnpm -F @super-harness/canvas-client dev    # http://localhost:5173
```

Open two tabs to co-edit: drag shapes, double-click to delete, ask the agent.
The client prefixes every message with `[board:<id>]` so the supervisor knows
which board's scene doc to edit — switch boards in the lobby and the chat
follows. Ask it to "clear the board" to see the approval gate.

## Run (2-node cluster, docker)

```bash
docker compose up --build      # needs AI_GATEWAY_API_KEY in the repo-root .env
```

Open **http://localhost:5174** and pick the node from the **selectbox in the
header** (node-1/2 → `ws://localhost:8811‑8812`; the selectbox appears because
the frontend container sets `VITE_NODE_BASE_PORT`). To see the cross-node proof
in one window: edit a board and chat on **node-1**, then flip the selectbox to
**node-2** — the client reconnects, carries the thread across, and the same
scene + conversation re-render from node-2's replica. That round-trip
(`node-1 → Postgres → Electric → node-2`) **is** the proof. Or open two windows
pinned to different nodes and drag in both at once — different shapes merge.

Postgres keeps its data in a named volume (`pgdata`), so boards, scenes, and
threads survive a `docker compose down` (without `-v`).

| Service | Host port | What |
| --- | --- | --- |
| frontend | 5174 | Vite dev server (the SPA) |
| node-1 | 8811 | super-line node (`ws://localhost:8811/super-line`), schema leader + seed |
| node-2 | 8812 | super-line node, boots after node-1 is healthy |
| control-center | 8082 | super-line Control Center, tapping node-1's inspector |
| postgres / electric | — | internal only |

## How it works

| Piece | Role |
| --- | --- |
| `shared/scene.ts` | The scene model (`{ shapes: { id → shape } }`) as a `document`-mode CRDT schema. Every field is `.catch(default)` — validate-before-commit runs against post-merge state, and a concurrent overwrite can transiently leave a field absent; a hard-required field would reject and resync-churn the doc (upstream ADR-0007 constraint). |
| `shared/contract.ts` | `defineContract({ plugins: [harnessContract()] })` + the host's two collections beside the four `harness.*` ones: `boards` (typed rows, key `id`) and `scenes` (`crdt: { mode: 'document' }`). |
| `server/server.ts` | The supervisor (no subagents) + the five canvas tools, each `scenes.read(boardId)` → `scenes.open(boardId, { origin: 'agent' })` → one Store primitive → close. `createHarness` with the `clear_board: 'ask'` gate and `maxSteps: 30`; `createSuperLineServer` with both backends, host RLS policies, and `plugins: [harness(engine), inspector()]`. Seeds the default board and couples scene-doc lifecycle to `boards` inserts/deletes via `collections.onChange`. |
| `client/src/lib/client.ts` | One `createSuperLineClient` per node (WS transport, `crdtCollectionsClient()`, shared principal `canvas`) + a borrowed-mode `createHarnessClient({ client, threadId })`. |
| `client/src/hooks/use-doc.ts` | Hand-written hook over the raw `DocHandle`: open on mount, `useSyncExternalStore`, close on cleanup; a rejected `ready` (fresh board's doc not created yet, or a lagging replica) surfaces as `missing` with a bounded retry. |
| `client/src/components/boards-lobby.tsx` | `superLineCollectionOptions(sl, contract, 'boards')` → a TanStack DB collection with `useLiveQuery`; optimistic insert/rename/delete, rejections surfaced via `.isPersisted.promise.catch`. |
| `client/src/components/board-canvas.tsx` | The 400×400 board: drag → merging `doc.update` per move, double-click → `doc.delete(['shapes', id])`, bring-to-front on grab. |
| `client/src/App.tsx` | Two panes over one socket: lobby + canvas left, harness chat right (ask banner, approval dialog, streamed `NodeView` tree). Sends `[board:<activeBoardId>] <text>`. |

The client half of the CRDT wire is the universal `crdtCollectionsClient` from
`@super-line/collections-crdt-memory` — the wire (base64 deltas) is identical
across backends; only the *server's* cross-node transport differs (memory
locally, central Postgres + Electric in the cluster).

## Environment

| Var | Meaning |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key (root `.env`) — the server exits without it. |
| `SUPER_HARNESS_PORT` | Server port (default `4116`). |
| `CHAT_MODEL` | Supervisor model (default `anthropic/claude-sonnet-4.5`). |
| `SUPER_HARNESS_STORAGE` | `memory` (default, single-node dev) or `pglite` (cluster: Mastra on central PG, collections on Electric-synced PGlite replicas). |
| `PG_URL` | Postgres URL — required in `pglite` mode. |
| `ELECTRIC_URL` | Electric shape URL (`pglite` mode). |
| `SUPER_HARNESS_INSPECTOR` | `0` disables the inspector plugin. |
| `NODE_NAME` | Log tag only (set per node by compose). |

## Inspector (super-line Control Center)

```bash
pnpm -F @super-harness/canvas-server inspect   # Control Center against ws://localhost:4116/super-line
```

In the cluster it runs on **http://localhost:8082** against node-1; the libp2p
presence mesh means that one connection surfaces both nodes, every tab, and the
live `scenes` doc traffic — agent writes stamped distinctly from human edits.
The inspector channel is **unauthenticated** — fine for this localhost demo;
disable with `SUPER_HARNESS_INSPECTOR=0` and never ship it on an internet-facing
node.

## Notes

- Each node's PGlite replica is **in-memory** — it re-folds the op-log from
  Electric on boot; central Postgres is the durable copy.
- Electric runs with `ELECTRIC_INSECURE: true` here — local dev only.
- The CRDT backend's compaction is on by default upstream (op-log folded into a
  baseline, superseded rows trimmed), so the scene op-log stays bounded.
- Peer discovery is mDNS (`discovery: 'mdns'`) — docker's bridge passes
  multicast; many cloud networks don't (swap for a bootstrap list there).
- Every tab on every node authenticates as the shared principal `canvas`
  (`userId ?? resourceId ?? 'local'`, and the client sends `resourceId: 'canvas'`).
  That single principal is what lets a `harness.membership` row written on
  node-1 admit a reader on node-2, and it's the `createdBy` the `boards` write
  policy checks. It also means there is no per-user isolation — this is a demo
  auth scheme, not a template.
