// Backend half of the fullstack web example: the dev-server topology (supervisor
// delegating to a weather worker) plus a GATED send_report tool so the approval
// flow is demoable end to end. Hosted on a Hono http server; the super-line WS
// transport attaches to the same node server after listen (same pattern as
// designer-server). Run it:
//
//   pnpm -F @super-harness/web-server dev        # tsx watch, loads root .env
//   pnpm -F @super-harness/web-client dev        # vite on :5173, in another shell
//
// Needs AI_GATEWAY_API_KEY in the root .env. Models via CHAT_MODEL /
// CHAT_MODEL_SMART (fast tier defaults to haiku, smart tier to sonnet); the
// Fast/Smart mode picker switches tiers per thread via mode metadata + the
// requestContext hook.
import { existsSync } from "node:fs"
import type { Server } from "node:http"
import { Hono } from "hono"
import { serve as serveHttp } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Agent } from "@mastra/core/agent"
import { RequestContext } from "@mastra/core/request-context"
import { createTool } from "@mastra/core/tools"
import { Memory } from "@mastra/memory"
import { LibSQLStore } from "@mastra/libsql"
import { PostgresStore } from "@mastra/pg"
import { createClient } from "@libsql/client"
import { gateway } from "ai"
import { z } from "zod"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { inspector } from "@super-line/plugin-inspector"
import { createSuperLineServer } from "@super-line/server"
import { defineContract } from "@super-line/core"
import { sqliteCollections } from "@super-line/collections-sqlite"
import { createHarness } from "@super-harness/core"
import { harness, harnessContract } from "@super-harness/server"
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'

const PORT = Number(process.env.SUPER_HARNESS_PORT ?? 4111)
// Model TIERS, selected per thread by the mode picker: each harness mode's
// metadata carries {model1 (supervisor), model2 (worker)}; the engine's
// requestContext hook copies them into the turn context, and both agents'
// `model` resolvers read them back. MODEL is the fast tier / fallback.
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
const MODEL_SMART = process.env.CHAT_MODEL_SMART ?? "anthropic/claude-sonnet-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

// Read a tier off the turn context (set by the requestContext hook below);
// absent (no modes, tests, resume edge) falls back to the fast model.
const tierModel = (key: "model1" | "model2") =>
  ({ requestContext }: { requestContext: RequestContext }) =>
    gateway((requestContext.get(key) as string | undefined) ?? MODEL)



const weatherTool = createTool({
  id: "get-weather",
  description: "Get the current weather for a city: temperature, humidity, wind, and conditions.",
  inputSchema: z.object({ location: z.string().describe('City name, e.g. "Istanbul"') }),
  outputSchema: z.object({
    location: z.string(),
    temperatureC: z.number(),
    humidity: z.number(),
    windKph: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ location }) => {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
    ).then((r) => r.json())
    const place = geo?.results?.[0]
    if (!place) throw new Error(`Could not find location "${location}"`)
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`,
    ).then((r) => r.json())
    const cur = wx.current
    return {
      location: [place.name, place.country].filter(Boolean).join(", "),
      temperatureC: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      windKph: cur.wind_speed_10m,
      conditions: "see temperature/wind",
    }
  },
})

// Deliberately fake: exists to exercise the approval dialog, not to send email.
const sendReportTool = createTool({
  id: "send_report",
  description: "Send a report by email. Requires human approval before it runs.",
  inputSchema: z.object({
    to: z.string().describe("Recipient email address"),
    subject: z.string(),
    body: z.string().describe("Report body, plain text"),
  }),
  outputSchema: z.object({ delivered: z.boolean(), id: z.string() }),
  execute: async ({ to, subject }) => {
    console.log(`[web-server] send_report approved → "${subject}" to ${to}`)
    return { delivered: true, id: `report-${Date.now().toString(36)}` }
  },
})

// Storage backend, chosen by a plain env var (SUPER_HARNESS_STORAGE, default
// libsql). Mastra's ground truth (threads/messages/mode) lives in libsql/postgres;
// the harness TREE rides super-line COLLECTIONS (their own backend):
//   libsql/postgres — Mastra on libsql/PG; tree collections on a local sqlite
//                     file (single-node dev; delete harness.db to reset the tree)
//   pglite          — tree collections = central PG + per-node Electric-synced
//                     replicas — the multi-node choice (docker-compose.yml)
const STORAGE = process.env.SUPER_HARNESS_STORAGE ?? "libsql"
const PG_URL = process.env.PG_URL ?? ""
const ELECTRIC_URL = process.env.ELECTRIC_URL

type TreeStorage = { type: "sqlite"; file: string } | { type: "pglite"; pgUrl: string; electricUrl?: string }
let storage: LibSQLStore | PostgresStore
let treeStorage: TreeStorage
if (STORAGE === "libsql") {
  const dbClient = createClient({ url: "file:./dev.db" })
  storage = new LibSQLStore({ id: "web", client: dbClient })
  treeStorage = { type: "sqlite", file: "./harness.db" }
} else {
  if (!PG_URL) {
    console.error(`SUPER_HARNESS_STORAGE=${STORAGE} needs PG_URL`)
    process.exit(2)
  }
  const pg = new PostgresStore({ id: "web", connectionString: PG_URL })
  storage = pg
  treeStorage =
    STORAGE === "pglite" ? { type: "pglite", pgUrl: PG_URL, electricUrl: ELECTRIC_URL } : { type: "sqlite", file: "./harness.db" }
}
const mem = () => new Memory({ storage, options: { lastMessages: 10 } })

// No memory: the worker has no `recall`, so a Memory here would only write
// scratch child-threads (id = delegate toolCallId) into the SAME storage the
// harness lists threads from — they'd show up in the client's thread sidebar.
const worker = new Agent({
  id: "worker",
  name: "Worker",
  instructions: "You are a focused worker. Use your weather tool to get real data, then report a short, concrete result.",
  model: tierModel("model2"),
  tools: { weather: weatherTool },
})

const supervisor = new Agent({
  id: "supervisor",
  name: "Supervisor",
  instructions: [
    "You coordinate a `worker` subagent that has a live weather tool.",
    "For any weather/data question you MUST delegate to the worker via the delegate tool (do not answer from memory), then summarize its report in one short sentence.",
    "When the user asks you to send or email a report, compose it from the conversation and call send_report — it is approval-gated, so a human confirms before it runs.",
    "The user may attach images, PDFs, or text files to a message; use the attached content directly when the model supports its media type.",
  ].join(" "),
  model: tierModel("model1"),
  tools: { send_report: sendReportTool },
  memory: mem(),
})

// One demo resource: every thread (whether created explicitly or sprung into
// existence by a first message) belongs to "web", matching the client's
// resourceId — so the sidebar scope, the resource room, and thread ownership
// all align. A real multi-tenant app would resolve the resource per connection
// (out of scope here; resourceFor is sync and can't see the connection).
const RESOURCE = "web"

const engine = createHarness({
  supervisor,
  subagents: [{ agent: worker }],
  memory: mem(), // enables the thread sidebar + per-thread mode persistence
  resourceFor: () => RESOURCE,
  // Modes are model TIERS here (the tomorrow-kits pattern): metadata carries the
  // per-tier models, the requestContext hook below copies them into the turn
  // context, and the agents' model resolvers read them back. Instructions still
  // overlay per mode — a mode can carry both.
  modes: [
    {
      id: "fast",
      name: "Fast",
      description: "Haiku everywhere — quick answers",
      instructions: "Answer conversationally.",
      metadata: { default: true, model1: MODEL, model2: MODEL },
    },
    {
      id: "smart",
      name: "Smart",
      description: "Sonnet supervisor, Haiku worker",
      metadata: { model1: MODEL_SMART, model2: MODEL },
    },
  ],
  // The per-turn host context: called once per turn (resumes included) with the
  // resolved mode + the message's attachments. Tier models ride the context to
  // BOTH agents' model resolvers — supervisor and delegated worker alike.
  requestContext: ({ mode }) => {
    const rc = new RequestContext()
    const meta = (mode?.metadata ?? {}) as { model1?: string; model2?: string }
    if (meta.model1) rc.set("model1", meta.model1)
    if (meta.model2) rc.set("model2", meta.model2)
    return rc
  },
  permissions: { tools: { send_report: "ask" } },
  generateTitle: {
    model: gateway("anthropic/claude-haiku-4.5"),
    // Title generation gets only the message TEXT (never its attachments), so a
    // message like "describe this image" reads as referencing something absent —
    // spell out that the model must TITLE it, never answer it, or the title
    // becomes "I don't see any image…".
    instructions:
      "Reply with ONLY a short 3-5 word title (a topic noun phrase) for the user's message — no quotes, no punctuation, no commentary. NEVER answer or respond to the message, even if it references an image or file you cannot see; in that case title it by its words (e.g. 'Image color question'). The exact text you return becomes the title.",
  },
})

const app = new Hono()
app.get("/health", (c) => c.json({ status: "ok", service: "web-server" }))

// Serve the built client when it exists (single-process deploy); in dev the
// client runs on vite :5173 and only the WS hits this server.
if (existsSync("../client/dist")) {
  app.use("/*", serveStatic({ root: "../client/dist" }))
  app.get("*", serveStatic({ path: "../client/dist/index.html" }))
} else {
  app.get("/", (c) => c.text("web-client not built — run `pnpm -F @super-harness/web-client dev` and open :5173"))
}

// Listen first, then attach the WS transport to the live node server — upgrade
// requests on /super-line never reach Hono routing.
const httpServer = serveHttp({ fetch: app.fetch, port: PORT }, (info) => {
  const node = process.env.NODE_NAME ? ` node=${process.env.NODE_NAME}` : ""
  console.log(`[web-server] http://localhost:${info.port}  ws://localhost:${info.port}/super-line  model=${MODEL}  storage=${STORAGE}${node}`)
}) as Server

// The plugin model, explicit (what serve() does under the hood). Build the tree
// collections backend from the selected storage: a local sqlite file by default;
// central PG + Electric-synced replicas for pglite (the multi-node choice, loaded
// on demand).
const collections =
  treeStorage.type === "pglite"
    ? await (await import("@super-line/collections-pglite")).pgliteCollections({
        pgUrl: treeStorage.pgUrl,
        electricUrl: treeStorage.electricUrl,
      })
    : sqliteCollections({ file: treeStorage.file })

// inspector: read-only Control Center tap (UNAUTHENTICATED — dev only), a
// first-class plugin composed after harness(). Watch live: pnpm -F
// @super-harness/web-server inspect
const INSPECTOR = process.env.SUPER_HARNESS_INSPECTOR !== "0"
const contract = defineContract({ plugins: [harnessContract()], roles: { user: {} } })
const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server: httpServer, path: "/super-line" })],
  collections,
  // Preserve serve()'s principal fallback userId ?? resourceId ?? 'local': the
  // client sends resourceId:'web' and no userId, so every tab on every node
  // authenticates as 'web' — which is what makes the cross-node tree read succeed.
  authenticate: (h) => {
    const q = (h as { query?: Record<string, string> })?.query ?? {}
    return { role: "user" as const, ctx: { userId: q.userId ?? q.resourceId ?? "local", resourceId: q.resourceId } }
  },
  identify: (conn) => (conn.ctx as { userId: string }).userId,
  plugins: [harness(engine), ...(INSPECTOR ? [inspector()] : [])],
  // The collections data bus needs no adapter — Electric is its CRDT bus. This
  // broker-less libp2p mesh is a SEPARATE plane carrying presence + inspector so
  // the Control Center sees the whole cluster: every node finds peers over mDNS.
  adapter: await createLibp2pAdapter({ discovery: "mdns" }),
})
srv.implement({} as never)
