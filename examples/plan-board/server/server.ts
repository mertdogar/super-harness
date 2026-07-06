// Backend for the "plan board" example: a scripted PLANNER that showcases the
// harness's todo/task feature end to end, alongside ask_user, delegation, and a
// gated tool. Standalone serve() over a bare node:http server — no Hono, libp2p,
// Electric, or Postgres. Run it:
//
//   pnpm -F @super-harness/plan-board-server dev     # tsx watch, loads root .env
//   pnpm -F @super-harness/plan-board-client dev     # vite on :5173, another shell
//
// Needs AI_GATEWAY_API_KEY in the root .env. Model via CHAT_MODEL (default sonnet
// — the four scripted beats want a strong instruction-follower).
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { createTool } from "@mastra/core/tools"
import { Memory } from "@mastra/memory"
import { LibSQLStore } from "@mastra/libsql"
import { gateway } from "@ai-sdk/gateway"
import { z } from "zod"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { createHarness } from "@super-harness/core"
import { serve } from "@super-harness/server"

const PORT = Number(process.env.SUPER_HARNESS_PORT ?? 4113)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-sonnet-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

// A real tool so a delegated subtask shows a concrete tool call in the execution
// view. Reused verbatim from dev-server.
const weatherTool = createTool({
  id: "get-weather",
  description: "Get the current weather for a city: temperature, humidity, wind, and conditions.",
  inputSchema: z.object({ location: z.string().describe('City name, e.g. "Rome"') }),
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

// Deliberately fake: exists to exercise the approval gate at the end of a plan,
// not to publish anything. Gating is keyed by tool name — the id here, the
// registration key on the supervisor, and the permissions key MUST all match.
const publishPlanTool = createTool({
  id: "publish_plan",
  description:
    "Publish the finished plan for the user. Requires human approval before it runs — call it only once every plan item is complete.",
  inputSchema: z.object({
    title: z.string().describe("Short title for the plan"),
    summary: z.string().describe("One-paragraph summary of the finished plan"),
  }),
  outputSchema: z.object({ published: z.boolean(), id: z.string() }),
  execute: async ({ title }) => {
    console.log(`[plan-board] publish_plan approved → "${title}"`)
    return { published: true, id: `plan-${title.length}` }
  },
})

// One shared LibSQL db. Mastra memory lets harness.listThreads work (the react
// client calls it on connect) and gives the planner cross-turn recall so you can
// ask it to revise the plan. serve()'s tree collections stay in-memory — the
// client mints a fresh threadId per load, so tree durability buys nothing here.
const storage = new LibSQLStore({ id: "plan-board", url: "file:./dev.db" })
const mem = () => new Memory({ storage, options: { lastMessages: 10 } })

const researcher = new Agent({
  id: "researcher",
  name: "Researcher",
  instructions:
    "You are a focused researcher. Use your weather tool when a task needs live conditions, then report a short, concrete result the planner can fold into its plan.",
  model: gateway(MODEL),
  tools: { weather: weatherTool },
})

// The scripted planner. todo/ask_user/delegate are injected by the harness per
// turn — they are NOT registered here; the instructions just have to drive them.
const supervisor = new Agent({
  id: "supervisor",
  name: "Planner",
  instructions: [
    "You are a planner. For any goal the user gives you, run this exact sequence IN A SINGLE TURN — never stop, hand back, or ask whether to continue until the final step is done:",
    "1. If a key detail is missing (e.g. dates, budget, party size), call ask_user ONCE to get it. Ask a single, specific question. Skip this only if the goal is already fully specified.",
    "2. Call the todo tool with a 4-6 item plan for the goal, every item status 'pending'. Send the FULL list every time you touch it.",
    "3. Then work the plan top to bottom, one item at a time. For each item: resend the whole list with that item 'in_progress', do the work, then resend the whole list with that item 'completed'. Never skip a status update — the UI renders this list live.",
    "4. Delegate exactly ONE research-flavored item (anything needing live facts) to the `researcher` subagent via the delegate tool, and fold its report in. Do the other items YOURSELF from your own knowledge — do not delegate them, and do not stop after the delegation returns.",
    "5. Once EVERY item is 'completed', you MUST call publish_plan. It is approval-gated, so a human confirms before it runs. Do not call it earlier, and do not end your turn without calling it.",
    "Keep your own prose short; the plan checklist and the execution stream carry the detail. Complete all of the above in this one response.",
  ].join(" "),
  model: gateway(MODEL),
  tools: { publish_plan: publishPlanTool },
  memory: mem(),
})

const harness = createHarness({
  supervisor,
  subagents: [{ agent: researcher }],
  memory: mem(), // enables harness.listThreads (client calls it on connect) + recall
  permissions: { tools: { publish_plan: "ask" } },
  // A full plan turn is ~15+ tool steps (ask_user, todo ×N, delegate, publish);
  // Mastra's default (~5) would cut it off after the first delegation.
  maxSteps: 30,
})

const httpServer = createServer()
await serve(harness, {
  storage: { type: "memory" },
  transports: [webSocketServerTransport({ server: httpServer, path: "/super-line" })],
})
httpServer.listen(PORT, () => console.log(`[plan-board] ws://localhost:${PORT}/super-line  model=${MODEL}`))
