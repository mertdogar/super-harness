// The payoff, server side: a full multi-agent harness added to YOUR OWN
// super-line server with a single plugin line. A supervisor delegates to a
// `researcher` subagent that has a local tool — so one turn exercises the whole
// tree (delegation + tool call + token streaming), all over one socket.
//
//   bun --env-file=../../.env src/server.ts       # from examples/plugin-usage
//   bun --env-file=../../.env src/client.ts        # second terminal
//
// Needs AI_GATEWAY_API_KEY in the root .env. Model via CHAT_MODEL (default haiku).
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { gateway } from "@ai-sdk/gateway"
import { z } from "zod"
import { createSuperLineServer } from "@super-line/server"
import { memoryCollections } from "@super-line/collections-memory"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { createHarness } from "@super-harness/core"
import { harness } from "@super-harness/server"
import { app } from "./contract"

const PORT = Number(process.env.PLUGIN_USAGE_PORT ?? 4115)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

// A tiny LOCAL tool (no network) so the delegate → tool → stream path always
// fires and the demo is fully self-contained.
const lookupPopulation = createTool({
  id: "lookup_population",
  description: "Look up the approximate population of a major city.",
  inputSchema: z.object({ city: z.string().describe('City name, e.g. "Istanbul"') }),
  outputSchema: z.object({ city: z.string(), population: z.number() }),
  execute: async ({ city }) => {
    const table: Record<string, number> = {
      istanbul: 15_460_000,
      tokyo: 13_960_000,
      "new york": 8_260_000,
      london: 8_866_000,
      paris: 2_103_000,
      berlin: 3_670_000,
    }
    return { city, population: table[city.trim().toLowerCase()] ?? 1_000_000 }
  },
})

const researcher = new Agent({
  id: "researcher",
  name: "Researcher",
  instructions:
    "You are a focused researcher. Use your lookup_population tool for any population question, then report the number in one short sentence.",
  model: gateway(MODEL),
  tools: { lookup_population: lookupPopulation },
})

const supervisor = new Agent({
  id: "supervisor",
  name: "Supervisor",
  instructions:
    "You coordinate a `researcher` subagent. For any factual/data question you MUST delegate to it via the delegate tool (never answer from memory), then summarize its finding in one short sentence.",
  model: gateway(MODEL),
})

// Transport-free engine: build it once with @super-harness/core, hand it to the
// plugin. No super-line concepts leak into the engine.
const engine = createHarness({ supervisor, subagents: [{ agent: researcher }] })

// ── The whole adoption story, in four lines ──────────────────────────────────
// Your contract already merges harnessContract() (see contract.ts). On the server
// you: give it ONE collections backend, map identify → your principal, and add
// harness(engine) to `plugins`. That's it — harness.* is subtracted from implement().
const httpServer = createServer()
const srv = createSuperLineServer(app, {
  transports: [webSocketServerTransport({ server: httpServer, path: "/ws" })],
  collections: memoryCollections(), // one backend serves the harness collections + any of yours
  // Dev-only query auth: the handshake carries userId; identify makes it the
  // collection principal the harness RLS keys on. In production swap this pair
  // for @super-line/plugin-auth (see examples/auth) — identify then comes free.
  authenticate: (h) => {
    const q = (h as { query?: Record<string, string> })?.query ?? {}
    return { role: "user" as const, ctx: { userId: q.userId ?? "local", resourceId: q.resourceId } }
  },
  identify: (conn) => (conn.ctx as { userId: string }).userId,
  plugins: [harness(engine)],
})

// Only YOUR request needs implementing — the plugin owns every harness.* handler.
srv.implement({ shared: { "app.serverInfo": async () => ({ name: "My App", harness: true }) }, user: {} })

httpServer.listen(PORT, () => {
  console.log(`[plugin-usage] ws://localhost:${PORT}/ws  model=${MODEL}`)
  console.log("[plugin-usage] now run the client:  pnpm -F @super-harness/plugin-usage client")
})
