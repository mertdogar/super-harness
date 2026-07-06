// Auth example, server side: the harness plugin BESIDE @super-line/plugin-auth on
// one server, one socket, ONE collections backend. The pairing is the whole point:
//   - authKit.authenticate / authKit.identify are wired top-level → the principal
//     becomes the logged-in userId, which the harness's collection RLS keys on.
//     (This is what makes the #1 composition footgun — a forgotten identify → a
//     silently empty tree — impossible: auth owns identify.)
//   - authKit.plugin sits in `plugins` next to harness(engine); a client signs up
//     / signs in and drives the harness as that authenticated user.
//
//   bun --env-file=../../.env src/server.ts       # from examples/auth
//   bun --env-file=../../.env src/client.ts       # second terminal
import { createServer } from "node:http"
import { Agent } from "@mastra/core/agent"
import { gateway } from "@ai-sdk/gateway"
import { createSuperLineServer } from "@super-line/server"
import { memoryCollections } from "@super-line/collections-memory"
import { webSocketServerTransport } from "@super-line/transport-websocket"
import { auth } from "@super-line/plugin-auth/server"
import { createHarness } from "@super-harness/core"
import { harness } from "@super-harness/server"
import { app } from "./contract"

const PORT = Number(process.env.AUTH_EXAMPLE_PORT ?? 4114)
const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("AI_GATEWAY_API_KEY is not set (put it in the root .env)")
  process.exit(2)
}

const engine = createHarness({
  supervisor: new Agent({
    id: "supervisor",
    name: "Supervisor",
    instructions: "You are a concise assistant. Answer in one short sentence.",
    model: gateway(MODEL),
  }),
  subagents: [],
})

// ONE backend serves BOTH the auth collections (users/sessions/…) and the harness
// collections (threads/nodes/tools/membership) — a single transaction domain.
const backend = memoryCollections()
const authKit = auth({ contract: app, collections: backend, defaultRoles: ["user"] })

const httpServer = createServer()
const srv = createSuperLineServer(app, {
  transports: [webSocketServerTransport({ server: httpServer, path: "/ws" })],
  collections: backend,
  authenticate: authKit.authenticate, // verifies the session token → { role, ctx }
  identify: authKit.identify, //          principal := userId → harness RLS keys on the logged-in user
  plugins: [harness(engine), authKit.plugin],
})

// harness.* AND auth.* are plugin-owned (subtracted) — nothing to implement here.
srv.implement({} as never)

httpServer.listen(PORT, () => console.log(`[auth-example] ws://localhost:${PORT}/ws  model=${MODEL}`))
