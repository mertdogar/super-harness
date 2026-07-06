// Composition demo, client side: ONE super-line client for BOTH surfaces —
// the host's own request rides the same socket as a full harness turn.
// @super-harness/react's headless HarnessClient runs in borrowed-client mode:
// it attaches its listeners to the host's client and close() detaches them
// without ever closing the socket.
import { createSuperLineClient } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { createHarnessClient } from "@super-harness/react/client"
import { hostContract } from "./contract"

const URL = process.env.COMPOSED_HOST_URL ?? "ws://localhost:4112/ws"

// The host app's one client — collections ride the built-in client.collection().
const line = createSuperLineClient(hostContract, {
  transport: webSocketClientTransport({ url: URL }),
  role: "user",
  params: { userId: "demo-user" },
})

// Host surface…
const { echoed } = await line["demo.echo"]({ text: "hello host" })
console.log(`[composed-client] demo.echo → ${echoed}`)

// …and the harness, borrowed onto the SAME socket.
const harness = createHarnessClient({ threadId: crypto.randomUUID(), client: line })
await harness.connect()

const done = new Promise<void>((resolve) => {
  let printed = ""
  harness.subscribe(() => {
    const s = harness.getSnapshot()
    const root = s.tree.nodes[s.tree.turns[s.tree.turns.length - 1] ?? ""]
    if (!root) return
    if (root.text.length > printed.length) {
      process.stdout.write(root.text.slice(printed.length))
      printed = root.text
    }
    if (root.status !== "running") resolve()
  })
})

await harness.send("Say hi to the composed world.")
await done
console.log("\n[composed-client] turn complete — one socket, two surfaces.")
harness.close() // borrowed: detaches the harness listeners only
line.close()
process.exit(0)
