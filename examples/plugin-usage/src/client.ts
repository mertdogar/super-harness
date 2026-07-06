// The payoff, client side: ONE super-line client drives BOTH surfaces — your
// app's own request and a full harness turn ride the same socket. The harness
// client is BORROWED (close() detaches its listeners, never closes the socket).
//
// The renderer is the point: it turns each tree snapshot into the shared
// HarnessEvent stream via diffTree() — the exact same fold a browser UI or an
// eval would use — and prints the new events indented by tree depth. Delegation
// shows up as a nested node; the whole multi-agent run streams into your terminal.
import { createSuperLineClient } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { createHarnessClient } from "@super-harness/react/client"
import { diffTree, emptyTree, type ClientTree, type HarnessEvent } from "@super-harness/shared"
import { app } from "./contract"

const URL = process.env.PLUGIN_USAGE_URL ?? "ws://localhost:4115/ws"
const PROMPT = process.argv.slice(2).join(" ") || "What's the population of Istanbul? Delegate to your researcher and cite the number."

const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`
const dim = (s: string) => paint("2", s)
const cyan = (s: string) => paint("36", s)
const green = (s: string) => paint("32", s)
const red = (s: string) => paint("31", s)
const tag = cyan("[plugin-usage]")

// One client for BOTH surfaces. Collections ride the built-in client.collection().
const line = createSuperLineClient(app, {
  transport: webSocketClientTransport({ url: URL }),
  role: "user",
  params: { userId: "demo-user" },
})

// Your own surface — proof it shares the socket with the harness.
const info = await line["app.serverInfo"]({})
console.log(`${tag} app.serverInfo → ${info.name} (harness: ${info.harness})`)

// The harness, borrowed onto the SAME socket.
const harness = createHarnessClient({ threadId: crypto.randomUUID(), client: line })
await harness.connect()

// Incremental terminal renderer over the shared diffTree() fold.
const reasoningOpen = new Set<string>()
const textOpen = new Set<string>()
const w = (s: string) => process.stdout.write(s)

function render(ev: HarnessEvent): void {
  const indent = "  ".repeat(ev.depth)
  switch (ev.type) {
    case "node_start":
      w(
        ev.depth === 0
          ? `\n${cyan("● ")}${ev.agentType ?? "supervisor"}`
          : `\n${indent}${cyan("▸ ")}${ev.agentType ?? "subagent"}${ev.task ? dim(` — ${ev.task}`) : ""}`,
      )
      break
    case "reasoning_delta":
      if (!reasoningOpen.has(ev.nodeId)) {
        w(`\n${indent}${dim("💭 ")}`)
        reasoningOpen.add(ev.nodeId)
      }
      w(dim(ev.text))
      break
    case "text_delta":
      if (!textOpen.has(ev.nodeId)) {
        w(`\n${indent}`)
        textOpen.add(ev.nodeId)
      }
      w(ev.text)
      break
    case "tool_start":
      w(`\n${indent}${dim("→ ")}${ev.toolName}${ev.args !== undefined ? " " + dim(JSON.stringify(ev.args)) : ""}`)
      break
    case "tool_end":
      w(`\n${indent}${ev.isError ? red("✗ ") : green("✓ ")}${dim(JSON.stringify(ev.result ?? null))}`)
      break
    case "error":
      w(`\n${indent}${red("✗ " + ev.message)}`)
      break
    case "node_end": {
      const total = ev.usage?.totalTokens
      w(`\n${indent}${green("✔ " + ev.reason)}${total ? dim(` · ${total.toLocaleString()} tokens`) : ""}`)
      reasoningOpen.delete(ev.nodeId)
      textOpen.delete(ev.nodeId)
      break
    }
  }
}

let prev: ClientTree = emptyTree()
const done = new Promise<void>((resolve) => {
  harness.subscribe(() => {
    const { tree } = harness.getSnapshot()
    for (const ev of diffTree(prev, tree)) render(ev)
    prev = tree
    const root = tree.nodes[tree.turns[tree.turns.length - 1] ?? ""]
    if (root && root.status !== "running") resolve()
  })
})

console.log(`${tag} sending: ${dim(PROMPT)}`)
await harness.send(PROMPT)
await done

const total = harness.getSnapshot().tree.usage?.totalTokens ?? 0
console.log(`\n\n${tag} turn complete — your surface + a full multi-agent harness on ONE socket. (${total.toLocaleString()} tokens)`)
harness.close() // borrowed: detaches harness listeners only
line.close()
process.exit(0)
