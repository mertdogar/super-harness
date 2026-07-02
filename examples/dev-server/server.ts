// A runnable super-harness server for local testing: a supervisor that delegates
// to a `worker` subagent (which has a live weather tool), wired through
// createHarness and served over a super-line WebSocket. Point the tui at it:
//
//   bun --env-file=../../.env server.ts               # from examples/dev-server
//   pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line
//
// Needs AI_GATEWAY_API_KEY in the root .env. Model via CHAT_MODEL (default haiku).
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { Memory } from "@mastra/memory"
import { LibSQLStore } from "@mastra/libsql"
import { gateway } from "@ai-sdk/gateway"
import { z } from "zod"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { createHarness } from "@super-harness/server"

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

const storage = new LibSQLStore({ id: "dev", url: "file:./dev.db" })
const mem = () => new Memory({ storage, options: { lastMessages: 10 } })

const worker = new Agent({
  id: "worker",
  name: "Worker",
  instructions: "You are a focused worker. Use your weather tool to get real data, then report a short, concrete result.",
  model: gateway(MODEL),
  tools: { weather: weatherTool },
  memory: mem(),
})

const supervisor = new Agent({
  id: "supervisor",
  name: "Supervisor",
  instructions:
    "You coordinate a `worker` subagent that has a live weather tool. For any weather/data question you MUST delegate to the worker via the delegate tool (do not answer from memory), then summarize its report in one short sentence.",
  model: gateway(MODEL),
  memory: mem(),
})

const httpServer = createServer()
await createHarness({
  supervisor,
  subagents: [{ agent: worker }],
  storage: { type: "memory" },
  transports: [webSocketServerTransport({ server: httpServer, path: "/super-line" })],
})
httpServer.listen(PORT, () => console.log(`[dev-server] ws://localhost:${PORT}/super-line  model=${MODEL}`))
