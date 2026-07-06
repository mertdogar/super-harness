// Composition demo, server side: a host app with its own super-line surface,
// running the harness as a PLUGIN beside it — one server, one socket, one auth,
// one collections backend for both. The four host obligations:
//   1. merge harnessContract() into the contract via `plugins` (contract.ts)
//   2. give the server ONE collections backend (serves the harness collections)
//   3. authenticate ctx carries userId (+resourceId); identify returns userId
//   4. add harness(engine) to `plugins` — harness.* is subtracted from implement()
//
//   bun --env-file=../../.env src/server.ts       # from examples/composed-host
//   bun --env-file=../../.env src/client.ts       # second terminal
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { gateway } from "@ai-sdk/gateway"
import { createSuperLineServer } from "@super-line/server"
import { memoryCollections } from "@super-line/collections-memory"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { createHarness } from "@super-harness/core"
import { harness } from "@super-harness/server"
import { hostContract } from "./contract"

const PORT = Number(process.env.COMPOSED_HOST_PORT ?? 4112)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

const engine = createHarness({
  supervisor: new Agent({
    id: "supervisor",
    name: "Supervisor",
    instructions: "You are a concise assistant embedded in a host app. Answer in one short sentence.",
    model: gateway(MODEL),
  }),
  subagents: [],
})

const httpServer = createServer()
const srv = createSuperLineServer(hostContract, {
  transports: [webSocketServerTransport({ server: httpServer, path: "/ws" })],
  // Host-owned auth. identify returns ctx.userId — the harness collections'
  // RLS keys on it (the principal falls back to the random conn.id otherwise,
  // and every membership-gated read is denied). In production pair with
  // @super-line/plugin-auth instead of this query-param stub.
  authenticate: (h) => {
    const q = (h as { query?: Record<string, string> })?.query ?? {}
    return { role: "user" as const, ctx: { userId: q.userId ?? "local", resourceId: q.resourceId } }
  },
  identify: (conn) => (conn.ctx as { userId: string }).userId,
  collections: memoryCollections(),
  plugins: [harness(engine)],
})

// harness.* is owned by the plugin (subtracted) — the host only implements its own.
srv.implement({ shared: { "demo.echo": async ({ text }) => ({ echoed: text.toUpperCase() }) }, user: {} })

httpServer.listen(PORT, () => console.log(`[composed-host] ws://localhost:${PORT}/ws  model=${MODEL}`))
