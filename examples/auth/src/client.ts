// Auth example, client side: sign up, then drive the harness AS the authenticated
// user. authClient hides super-line's guest→user reconnect — signUp connects as a
// guest, mints a session, and reconnects as `user`; `alice.client` is that authed
// super-line client, whose identify() principal is Alice's userId. Handing it to
// createHarnessClient (borrowed mode) means every harness collection read/write is
// scoped to her — RLS + membership, for free.
import { createSuperLineClient } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { authClient } from "@super-line/plugin-auth/client"
import { createHarnessClient } from "@super-harness/react/client"
import { app } from "./contract"

const URL = process.env.AUTH_EXAMPLE_URL ?? "ws://localhost:4114/ws"

const connect = ({ role, params }: { role: string; params: Record<string, string> }) =>
  createSuperLineClient(app, { transport: webSocketClientTransport({ url: URL }), role: role as "user", params })

const alice = authClient({ authedRole: "user", connect })
await alice.signUp({ email: "alice@example.com", password: "correct-horse", displayName: "Alice" })
// whoami() is an auth-plugin request; the loose Contract annotation (see contract.ts) hides it, so name it here.
console.log("[auth-client] signed up:", await (alice.client as unknown as { whoami(): Promise<unknown> }).whoami())

// The harness borrows Alice's authenticated client — one socket, both surfaces.
const harness = createHarnessClient({ threadId: crypto.randomUUID(), client: alice.client as never })
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

await harness.send("Say hi to the authenticated world.")
await done
console.log("\n[auth-client] turn complete — the harness ran as the logged-in user.")
harness.close()
alice.client.close()
process.exit(0)
