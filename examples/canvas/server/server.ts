// Backend for the "canvas" example: a harness supervisor that co-edits shared
// CRDT scene documents with the user, live. The harness rides plain row
// collections (harness.* via harnessContract()); the canvas itself is two host
// collections — `boards` (LWW lobby rows, client-writable under RLS) and
// `scenes` (CRDT documents, one per board) — that the supervisor's tools write
// through a server-side CrdtServerReplica, so agent edits land as Store deltas
// that merge with whatever a human is doing in another tab. Run it:
//
//   pnpm -F @super-harness/canvas-server dev     # tsx watch, loads root .env
//   pnpm -F @super-harness/canvas-client dev     # vite on :5174, another shell
//
// Needs AI_GATEWAY_API_KEY in the root .env. SUPER_HARNESS_STORAGE selects the
// backend: memory (default, single-node dev) | pglite (docker cluster: central
// Postgres + Electric-synced replicas + a libp2p presence/inspector mesh).
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { Memory } from "@mastra/memory"
import { LibSQLStore } from "@mastra/libsql"
import { PostgresStore } from "@mastra/pg"
import { gateway } from "@ai-sdk/gateway"
import { z } from "zod"
import type { CrdtServerReplica } from "@super-line/core"
import { createSuperLineServer, type ServerCrdtCollectionHandle } from "@super-line/server"
import { memoryCollections } from "@super-line/collections-memory"
import { crdtMemoryCollections } from "@super-line/collections-crdt-memory"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { inspector } from "@super-line/plugin-inspector"
import { createHarness } from "@super-harness/core"
import { harness } from "@super-harness/server"
import { contract } from "../shared/contract.js"
import { COLORS, DEFAULT_BOARD_ID, newShapeId, topOrder, type Scene } from "../shared/scene.js"

const PORT = Number(process.env.SUPER_HARNESS_PORT ?? 4116)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-sonnet-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

// Storage, env-selected (SUPER_HARNESS_STORAGE, default memory). Mastra's
// ground truth (threads/messages) and the two collections backends are chosen
// together; the pglite trio (row collections, CRDT collections, libp2p adapter)
// is imported dynamically so memory mode stays light.
const STORAGE = process.env.SUPER_HARNESS_STORAGE ?? "memory"
const PG_URL = process.env.PG_URL ?? ""
const ELECTRIC_URL = process.env.ELECTRIC_URL

let storage: LibSQLStore | PostgresStore
if (STORAGE === "pglite") {
  if (!PG_URL) {
    console.error(`SUPER_HARNESS_STORAGE=${STORAGE} needs PG_URL`)
    process.exit(2)
  }
  storage = new PostgresStore({ id: "canvas", connectionString: PG_URL })
} else {
  storage = new LibSQLStore({ id: "canvas", url: "file:./dev.db" })
}
const mem = () => new Memory({ storage, options: { lastMessages: 10 } })

// Row collections (harness.* tree + boards lobby): one backend serves both.
const collections =
  STORAGE === "pglite"
    ? await (await import("@super-line/collections-pglite")).pgliteCollections({
        pgUrl: PG_URL,
        electricUrl: ELECTRIC_URL,
      })
    : memoryCollections()

// CRDT documents (scenes) are a SEPARATE backend family. The pglite backend's
// docOptions must mirror the contract's `crdt: { mode: 'document' }` — Electric
// feeds this node's replicas outside the request path, where the contract def
// isn't in hand (same as upstream ai-canvas-pglite).
const crdtCollections =
  STORAGE === "pglite"
    ? await (await import("@super-line/collections-crdt-pglite")).crdtPgliteCollections({
        pgUrl: PG_URL,
        electricUrl: ELECTRIC_URL,
        docOptions: () => ({ mode: "document" }),
      })
    : crdtMemoryCollections()

// Electric is the collections CRDT bus; this broker-less libp2p mesh is a
// SEPARATE plane carrying presence + inspector so the Control Center sees the
// whole cluster (mDNS peer discovery, no node list to pre-compute).
const adapter =
  STORAGE === "pglite"
    ? await (await import("@super-line/adapter-libp2p")).createLibp2pAdapter({ discovery: "mdns" })
    : undefined

// The supervisor's write path: open a reactive server co-writer over the
// board's canonical scene doc, apply one Store primitive, close. read() first
// strong-folds the doc so getSnapshot() is current even on a node whose
// Electric replica hasn't caught up (open() is synchronous and can't await).
// `origin: 'agent'` stamps the agent's deltas, distinct from human edits.
let scenes!: ServerCrdtCollectionHandle<Scene>
async function withScene<T>(boardId: string, fn: (replica: CrdtServerReplica) => T): Promise<T> {
  await scenes.read(boardId)
  const replica = scenes.open(boardId, { origin: "agent" })
  try {
    return fn(replica)
  } finally {
    replica.close()
  }
}
const snapshot = (replica: CrdtServerReplica): Scene | undefined => replica.getSnapshot() as Scene | undefined

const boardIdInput = z.string().describe("Board to edit — the id from the [board:<id>] prefix on the user's message")

const addShapeTool = createTool({
  id: "add_shape",
  description: "Add a new labelled square shape to a board.",
  inputSchema: z.object({
    boardId: boardIdInput,
    x: z.number().describe("left position, 0..380"),
    y: z.number().describe("top position, 0..380"),
    color: z.string().describe("hex color, e.g. #3b82f6"),
    label: z.string().max(6).describe("short label shown on the shape"),
  }),
  outputSchema: z.object({ id: z.string() }),
  execute: async ({ boardId, x, y, color, label }) =>
    withScene(boardId, (replica) => {
      const id = newShapeId()
      replica.update({ shapes: { [id]: { x, y, color, label, order: topOrder(snapshot(replica)) } } })
      return { id }
    }),
})

const moveShapeTool = createTool({
  id: "move_shape",
  description: "Move an existing shape on a board to a new position.",
  inputSchema: z.object({
    boardId: boardIdInput,
    id: z.string().describe("shape id, e.g. S_abc123"),
    x: z.number().describe("left position, 0..380"),
    y: z.number().describe("top position, 0..380"),
  }),
  outputSchema: z.object({ ok: z.boolean(), error: z.string().optional() }),
  execute: async ({ boardId, id, x, y }) =>
    withScene(boardId, (replica) => {
      if (!snapshot(replica)?.shapes?.[id]) return { ok: false, error: "no such shape" }
      replica.update({ shapes: { [id]: { x, y } } })
      return { ok: true }
    }),
})

const restyleShapeTool = createTool({
  id: "restyle_shape",
  description: "Change an existing shape's color and/or label.",
  inputSchema: z.object({
    boardId: boardIdInput,
    id: z.string().describe("shape id, e.g. S_abc123"),
    color: z.string().optional().describe("new hex color, e.g. #10b981"),
    label: z.string().max(6).optional().describe("new short label"),
  }),
  outputSchema: z.object({ ok: z.boolean(), error: z.string().optional() }),
  execute: async ({ boardId, id, color, label }) =>
    withScene(boardId, (replica) => {
      if (!snapshot(replica)?.shapes?.[id]) return { ok: false, error: "no such shape" }
      const patch: { color?: string; label?: string } = {}
      if (color !== undefined) patch.color = color
      if (label !== undefined) patch.label = label
      if (!Object.keys(patch).length) return { ok: false, error: "pass color and/or label" }
      replica.update({ shapes: { [id]: patch } })
      return { ok: true }
    }),
})

const deleteShapeTool = createTool({
  id: "delete_shape",
  description: "Delete a shape from a board.",
  inputSchema: z.object({
    boardId: boardIdInput,
    id: z.string().describe("shape id, e.g. S_abc123"),
  }),
  outputSchema: z.object({ ok: z.boolean(), error: z.string().optional() }),
  execute: async ({ boardId, id }) =>
    withScene(boardId, (replica) => {
      if (!snapshot(replica)?.shapes?.[id]) return { ok: false, error: "no such shape" }
      // delete(path) is the only key-removing surface — atomic in-process, so it
      // never clobbers concurrent edits to sibling shapes (update() merges).
      replica.delete(["shapes", id])
      return { ok: true }
    }),
})

// Approval-gated: the name must match in three places — this id, the Agent
// tools key, and permissions.tools below — or the gate silently never arms.
const clearBoardTool = createTool({
  id: "clear_board",
  description:
    "Delete EVERY shape on a board. Destructive — requires human approval before it runs. Call it only when the user explicitly asks to clear or wipe the board.",
  inputSchema: z.object({ boardId: boardIdInput }),
  outputSchema: z.object({ cleared: z.number() }),
  execute: async ({ boardId }) =>
    withScene(boardId, (replica) => {
      // Per-shape delete(path), never a whole-doc set: each removal merges with
      // concurrent edits instead of clobbering the document wholesale.
      const ids = Object.keys(snapshot(replica)?.shapes ?? {})
      for (const id of ids) replica.delete(["shapes", id])
      return { cleared: ids.length }
    }),
})

// No subagents — the canvas supervisor works alone. The client prefixes every
// message with "[board:<id>] " so the model knows which scene doc to edit.
const supervisor = new Agent({
  id: "supervisor",
  name: "Canvas",
  instructions: [
    "You co-edit a shared visual canvas with the user, live. Each shape is a labelled square on a board.",
    'Every user message is prefixed with the board it was sent from, e.g. "[board:B_abc123] add a red square" — that id names the board to edit. Pass it as boardId to EVERY tool call.',
    "Make every edit by calling tools — never describe an edit without doing it.",
    "Positions: x and y are 0..380, top-left origin. Prefer the palette: " + COLORS.join(", ") + ".",
    "clear_board wipes the whole board and is human-approval-gated — call it only when the user explicitly asks to clear or wipe the board, never as a shortcut.",
    "Keep your prose to one short line; the canvas carries the result.",
  ].join(" "),
  model: gateway(MODEL),
  tools: {
    add_shape: addShapeTool,
    move_shape: moveShapeTool,
    restyle_shape: restyleShapeTool,
    delete_shape: deleteShapeTool,
    clear_board: clearBoardTool,
  },
  memory: mem(),
})

const engine = createHarness({
  supervisor,
  memory: mem(), // enables harness.listThreads (client calls it on connect) + recall
  // The core's fallback for a tool with no rule is 'ask' (built-ins excepted),
  // so every agent-registered tool needs an explicit entry — list the four
  // ungated canvas tools as 'allow' or they ALL gate, not just clear_board.
  permissions: {
    tools: {
      add_shape: "allow",
      move_shape: "allow",
      restyle_shape: "allow",
      delete_shape: "allow",
      clear_board: "ask",
    },
  },
  maxSteps: 30, // a multi-shape edit is many tool steps; Mastra's default (~5) would cut it off
  generateTitle: {
    model: gateway("anthropic/claude-haiku-4.5"),
    instructions:
      "Reply with ONLY a short 3-5 word title summarizing the user's message — no quotes, no trailing punctuation, no commentary. The exact text you return will be used as the title.",
  },
})

// The plugin model, explicit: the shared contract already merges
// harnessContract() beside the host's boards/scenes collections; the server
// gets both backends, host policies for the host collections (harness.* policies
// come from the harness plugin), and harness(engine) in plugins.
const INSPECTOR = process.env.SUPER_HARNESS_INSPECTOR !== "0"
const httpServer = createServer()
const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server: httpServer, path: "/super-line" })],
  collections,
  crdtCollections,
  policies: {
    // Lobby rows: world-readable; only the creator principal may mutate a board.
    boards: {
      read: () => undefined,
      write: (principal, op, next, prev) =>
        op === "insert" ? next?.createdBy === principal : prev?.createdBy === principal,
    },
    // Scene docs: everyone co-edits (guard shape — CRDT policies are bools, not filters).
    scenes: { read: () => true, write: () => true },
  },
  // Preserve serve()'s principal fallback userId ?? resourceId ?? 'local': the
  // client sends resourceId:'canvas' and no userId, so every tab on every node
  // authenticates as 'canvas' — which is what lets the harness.membership RLS
  // row written on one node admit readers on another.
  authenticate: (h) => {
    const q = (h as { query?: Record<string, string> })?.query ?? {}
    return { role: "user" as const, ctx: { userId: q.userId ?? q.resourceId ?? "local", resourceId: q.resourceId } }
  },
  identify: (conn) => (conn.ctx as { userId: string }).userId,
  plugins: [harness(engine), ...(INSPECTOR ? [inspector()] : [])],
  ...(adapter ? { adapter } : {}),
})
srv.implement({} as never)

scenes = srv.collection("scenes")

// Seed the default board once, server-authoritative. Guarded so a restart with
// a durable backend (or a concurrently-booting cluster node) doesn't throw:
// scenes.create CONFLICTs, boards is read-checked then insert-caught.
try {
  await scenes.create(DEFAULT_BOARD_ID, { shapes: {} })
  console.log("[canvas] seeded default scene")
} catch {
  console.log("[canvas] default scene already exists")
}
const boards = srv.collection("boards")
if (!(await boards.read(DEFAULT_BOARD_ID))) {
  try {
    await boards.insert({ id: DEFAULT_BOARD_ID, name: "Shared board", createdBy: "canvas", createdAt: Date.now() })
  } catch {
    // another node won the insert race — fine
  }
}

// Scene docs are server-created only (clients open EXISTING docs), but boards
// rows are client-inserted — so couple the doc lifecycle to the lobby row via
// the backend's change feed. create CONFLICTs when another node (or a restart)
// already made it; delete is idempotent and fans `deleted` to open handles.
collections.onChange((change) => {
  if (change.n !== "boards") return
  if (change.k === "insert") void scenes.create(change.id, { shapes: {} }).catch(() => {})
  if (change.k === "delete") void scenes.delete(change.id).catch(() => {})
})

httpServer.listen(PORT, () => {
  const node = process.env.NODE_NAME ? ` node=${process.env.NODE_NAME}` : ""
  console.log(`[canvas] ws://localhost:${PORT}/super-line  model=${MODEL}  storage=${STORAGE}${node}`)
})
