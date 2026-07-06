// Backend half of the fullstack web example: the dev-server topology (supervisor
// delegating to a weather worker) plus a GATED send_report tool so the approval
// flow is demoable end to end. Hosted on a Hono http server; the super-line WS
// transport attaches to the same node server after listen (same pattern as
// designer-server). Run it:
//
//   pnpm -F @super-harness/web-server dev        # tsx watch, loads root .env
//   pnpm -F @super-harness/web-client dev        # vite on :5173, in another shell
//
// Needs AI_GATEWAY_API_KEY in the root .env. Model via CHAT_MODEL (default haiku).
import { existsSync } from "node:fs"
import type { Server } from "node:http"
import { Hono } from "hono"
import { serve as serveHttp } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Agent } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { Memory } from "@mastra/memory"
import { LibSQLStore } from "@mastra/libsql"
import { PostgresStore } from "@mastra/pg"
import { createClient } from "@libsql/client"
import { gateway } from "ai"
import { z } from "zod"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { inspector } from "@super-line/plugin-inspector"
import { createHarness } from "@super-harness/core"
import { serve, type ServeConfig } from "@super-harness/server"
import { createLibp2pAdapter } from '@super-line/adapter-libp2p'

const PORT = Number(process.env.SUPER_HARNESS_PORT ?? 4111)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}



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

let storage: LibSQLStore | PostgresStore
let treeStorage: ServeConfig["storage"]
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
  model: gateway(MODEL),
  tools: { weather: weatherTool },
})

const supervisor = new Agent({
  id: "supervisor",
  name: "Supervisor",
  instructions: [
    "You coordinate a `worker` subagent that has a live weather tool.",
    "For any weather/data question you MUST delegate to the worker via the delegate tool (do not answer from memory), then summarize its report in one short sentence.",
    "When the user asks you to send or email a report, compose it from the conversation and call send_report — it is approval-gated, so a human confirms before it runs.",
  ].join(" "),
  model: gateway(MODEL),
  tools: { send_report: sendReportTool },
  memory: mem(),
})

// One demo resource: every thread (whether created explicitly or sprung into
// existence by a first message) belongs to "web", matching the client's
// resourceId — so the sidebar scope, the resource room, and thread ownership
// all align. A real multi-tenant app would resolve the resource per connection
// (out of scope here; resourceFor is sync and can't see the connection).
const RESOURCE = "web"

const harness = createHarness({
  supervisor,
  subagents: [{ agent: worker }],
  memory: mem(), // enables the thread sidebar + per-thread mode persistence
  resourceFor: () => RESOURCE,
  modes: [
    { id: "chat", name: "Chat", instructions: "Answer conversationally.", metadata: { default: true } },
    { id: "terse", name: "Terse", instructions: "Reply in one short sentence, no pleasantries." },
  ],
  permissions: { tools: { send_report: "ask" } },
  generateTitle: {
    model: gateway("anthropic/claude-haiku-4.5"),
    // Mastra's own default title prompt spells out "the entire text you
    // return will be used as the title" — without that framing haiku treats
    // this as a style hint and answers the user's message instead of titling it.
    instructions:
      "Reply with ONLY a short 3-5 word title summarizing the user's message — no quotes, no trailing punctuation, no commentary. The exact text you return will be used as the title.",
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

// inspector: read-only Control Center tap, UNAUTHENTICATED — dev only. Now a
// first-class plugin (@super-line/plugin-inspector) composed via serve()'s
// `plugins` — its connection class negotiates the CC subprotocol itself, so the
// transport no longer carries an `inspector` flag.
// Watch live: pnpm -F @super-harness/web-server inspect
const INSPECTOR = process.env.SUPER_HARNESS_INSPECTOR !== "0"
await serve(harness, {
  storage: treeStorage,
  transports: [webSocketServerTransport({ server: httpServer, path: "/super-line" })],
  plugins: INSPECTOR ? [inspector()] : [],
  // The collections backend needs no adapter — Electric is its CRDT bus. This broker-less libp2p mesh is a
  // SEPARATE plane carrying presence + inspector so the Control Center sees the whole cluster. No node list,
  // no bootstrap, no peer IDs — every node finds its peers over mDNS and the adapter dials them itself.
  adapter: await createLibp2pAdapter({ discovery: 'mdns' }),
})
