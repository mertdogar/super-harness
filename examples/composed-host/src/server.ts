// Composition demo, server side: a host app with its own super-line surface,
// mounting the harness BESIDE it — one server, one socket, one auth for both.
// The four host obligations:
//   1. merge harnessSurface into the contract's `shared` block (contract.ts)
//   2. spread `await harnessStores(...)` into `stores`
//   3. authenticate ctx extends HarnessCtx, and identify returns ctx.userId
//   4. spread mountHarness(srv, harness).handlers into implement()
//
//   bun --env-file=../../.env src/server.ts       # from examples/composed-host
//   bun --env-file=../../.env src/client.ts       # second terminal
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { gateway } from "@ai-sdk/gateway"
import { createSuperLineServer } from "@super-line/server"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { createHarness } from "@super-harness/core"
import { harnessStores, mountHarness } from "@super-harness/server"
import { hostContract } from "./contract"

const PORT = Number(process.env.COMPOSED_HOST_PORT ?? 4112)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

const harness = createHarness({
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
  // Host-owned auth. identify MUST return ctx.userId: the harness grants
  // store ACLs to it, and the principal falls back to the random conn.id
  // otherwise — every tree read would be silently denied.
  authenticate: (h) => {
    const q = (h as { query?: Record<string, string> })?.query ?? {}
    return { role: "user" as const, ctx: { userId: q.userId ?? "local", resourceId: q.resourceId } }
  },
  identify: (conn) => (conn.ctx as { userId: string }).userId,
  stores: { ...(await harnessStores({ type: "memory" })) },
})

const mount = mountHarness(srv, harness)
srv.implement({
  shared: {
    ...mount.handlers,
    "demo.echo": async ({ text }) => ({ echoed: text.toUpperCase() }),
  },
  user: {},
})

httpServer.listen(PORT, () => console.log(`[composed-host] ws://localhost:${PORT}/ws  model=${MODEL}`))
