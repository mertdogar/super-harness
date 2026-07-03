import { afterEach, describe, expect, it } from "vitest"
import type { NodeState, ThreadDoc } from "@super-harness/shared"
import { createHarnessClient, type HarnessClient, type HarnessClientConfig } from "./harness-client"

// ── fake wire ─────────────────────────────────────────────────────────────────
// Structural stand-in for the super-line client: request methods, room-event
// handlers, and Store handles that subscribeTree drives.

class FakeHandle {
  #data: unknown = undefined
  #subs = new Set<() => void>()
  closed = false
  getSnapshot = () => this.#data
  subscribe = (cb: () => void) => {
    this.#subs.add(cb)
    return () => this.#subs.delete(cb)
  }
  close = () => {
    this.closed = true
    this.#subs.clear()
  }
  write(data: unknown) {
    this.#data = data
    for (const cb of this.#subs) cb()
  }
}

function fakeWire(overrides: Record<string, unknown> = {}) {
  const handles = new Map<string, FakeHandle>()
  const handlers = new Map<string, (p: unknown) => void>()
  const calls: Record<string, number> = {}
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const handle = (ns: string, id: string): FakeHandle => {
    const key = `${ns}:${id}`
    let h = handles.get(key)
    if (!h || h.closed) {
      h = new FakeHandle()
      handles.set(key, h)
    }
    return h
  }
  const wire = {
    connected: true,
    join: async () => (count("join"), { ok: true }),
    sendMessage: async () => (count("sendMessage"), { ok: true }),
    resumeMessage: async () => (count("resumeMessage"), { ok: true }),
    abort: async () => (count("abort"), { ok: true }),
    respondToApproval: async () => (count("respondToApproval"), { ok: true }),
    switchMode: async () => (count("switchMode"), { ok: true }),
    listModes: async () => (count("listModes"), { modes: [], defaultModeId: undefined }),
    listThreads: async () => (count("listThreads"), { threads: [] }),
    createThread: async () => (count("createThread"), { threadId: "fresh-thread" }),
    deleteThread: async () => (count("deleteThread"), { ok: true }),
    renameThread: async () => (count("renameThread"), { ok: true }),
    on: (name: string, cb: (p: unknown) => void) => {
      handlers.set(name, cb)
      return () => handlers.delete(name)
    },
    // Real client close() is terminal — mirror that so identity/abandon
    // guards are actually exercised, not vacuously satisfied.
    close: () => {
      wire.connected = false
      handlers.clear()
    },
    store: (ns: string) => ({ open: (id: string) => handle(ns, id) }),
    ...overrides,
  }
  return {
    wire: wire as unknown as WireInstance,
    raw: wire,
    handle,
    calls,
    emit: (name: string, p: unknown) => handlers.get(name)?.(p),
  }
}

type WireInstance = Exclude<NonNullable<HarnessClientConfig["wire"]>, (...args: never) => unknown>

function node(partial: Partial<NodeState> & { nodeId: string }): NodeState {
  return {
    parentNodeId: null,
    depth: 0,
    status: "running",
    reasoning: "",
    text: "",
    toolOrder: [],
    tools: {},
    childOrder: [],
    ...partial,
  }
}

type Fake = ReturnType<typeof fakeWire>

// Write the thread skeleton + node docs the way the server's projector would.
function writeTree(f: Fake, threadId: string, turns: string[], nodes: Record<string, NodeState>) {
  const skeleton: ThreadDoc = { turns, nodes: {} }
  for (const [id, n] of Object.entries(nodes)) {
    skeleton.nodes[id] = { parentNodeId: n.parentNodeId, depth: n.depth, agentType: n.agentType, childOrder: n.childOrder }
  }
  f.handle("thread", threadId).write(skeleton)
  for (const [id, n] of Object.entries(nodes)) f.handle("node", id).write(n)
}

const clients: HarnessClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

async function setup(overrides: Record<string, unknown> = {}) {
  const f = fakeWire(overrides)
  const client = createHarnessClient({ url: "ws://test", threadId: "t1", wire: f.wire })
  clients.push(client)
  await client.connect()
  return { f, client }
}

const ASK = {
  toolCallId: "a1",
  toolName: "ask_user",
  status: "input-available" as const,
  argsText: "",
  args: { question: "which city?" },
}

describe("HarnessClient state machine", () => {
  it("derives busy from the last root and refreshes threads when a turn settles", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "working" }) })
    expect(client.getSnapshot().busy).toBe(true)

    const before = f.calls.listThreads ?? 0
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "done", status: "complete" }) })
    expect(client.getSnapshot().busy).toBe(false)
    expect(f.calls.listThreads).toBe(before + 1) // settle → thread list refresh
  })

  it("infers a pending ask from the tree (refresh mid-suspension) and reads it as not-busy", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], {
      r1: node({ nodeId: "r1", toolOrder: ["a1"], tools: { a1: { ...ASK } } }),
    })
    const s = client.getSnapshot()
    expect(s.pendingAsk).toMatchObject({ toolCallId: "a1", request: { question: "which city?" } })
    expect(s.busy).toBe(false) // parked server-side, not busy

    // resume happened elsewhere: the ask settles, the turn completes
    writeTree(f, "t1", ["r1"], {
      r1: node({
        nodeId: "r1",
        status: "complete",
        toolOrder: ["a1"],
        tools: { a1: { ...ASK, status: "output-available", result: "Izmir" } },
      }),
    })
    expect(client.getSnapshot().pendingAsk).toBeNull()
  })

  it("ignores a stale still-running earlier root — only the LAST turn can ask", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1", "r2"], {
      r1: node({ nodeId: "r1", toolOrder: ["a1"], tools: { a1: { ...ASK } } }), // stale, pre-abort-fix data
      r2: node({ nodeId: "r2", text: "new turn" }),
    })
    const s = client.getSnapshot()
    expect(s.pendingAsk).toBeNull()
    expect(s.busy).toBe(true)
  })

  it("keeps the prompt and sets a notice when reply is rejected (ok:false)", async () => {
    const ok = { value: false }
    const { f, client } = await setup({ resumeMessage: async () => ({ ok: ok.value }) })
    f.emit("suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: { question: "q" } })
    expect(client.getSnapshot().pendingAsk).not.toBeNull()

    await client.reply("Izmir")
    expect(client.getSnapshot().pendingAsk).not.toBeNull() // answer not silently lost
    expect(client.getSnapshot().notice).toContain("rejected")

    ok.value = true
    await client.reply("Izmir")
    expect(client.getSnapshot().pendingAsk).toBeNull()
    expect(client.getSnapshot().notice).toBeNull()
  })

  it("a live suspended event flips busy true → false and parks the ask", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "thinking" }) })
    expect(client.getSnapshot().busy).toBe(true)
    f.emit("suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    expect(client.getSnapshot().busy).toBe(false)
    expect(client.getSnapshot().pendingAsk).toMatchObject({ toolCallId: "a1" })
  })

  it("abort clears busy/pendings/queue locally (tui parity)", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "running" }) })
    f.emit("approvalRequired", { threadId: "t1", nodeId: "r1", toolCallId: "g1", toolName: "send_report", args: {} })
    f.emit("followUpQueued", { threadId: "t1", count: 2 })
    expect(client.getSnapshot().busy).toBe(true) // genuinely busy before abort
    expect(client.getSnapshot().pendingApproval).not.toBeNull()

    await client.abort()
    const s = client.getSnapshot()
    expect(s.pendingApproval).toBeNull()
    expect(s.pendingAsk).toBeNull()
    expect(s.busy).toBe(false)
    expect(s.queued).toBe(0)
  })

  it("pendingApproval lifecycle: parked by the event, cleared when the tree settles the tool", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], {
      r1: node({
        nodeId: "r1",
        toolOrder: ["g1"],
        tools: { g1: { toolCallId: "g1", toolName: "send_report", status: "input-available", argsText: "", args: {} } },
      }),
    })
    f.emit("approvalRequired", { threadId: "t1", nodeId: "r1", toolCallId: "g1", toolName: "send_report", args: {} })
    expect(client.getSnapshot().pendingApproval).toMatchObject({ toolCallId: "g1" })

    // approval resolved elsewhere → the tool executes and settles in the tree
    writeTree(f, "t1", ["r1"], {
      r1: node({
        nodeId: "r1",
        toolOrder: ["g1"],
        tools: { g1: { toolCallId: "g1", toolName: "send_report", status: "output-available", argsText: "", result: { delivered: true } } },
      }),
    })
    expect(client.getSnapshot().pendingApproval).toBeNull()
  })

  it("dismissAsk drops a prompt the server no longer knows about", async () => {
    const { f, client } = await setup()
    f.emit("suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    client.dismissAsk()
    expect(client.getSnapshot().pendingAsk).toBeNull()
  })

  it("filters room events by the active thread", async () => {
    const { f, client } = await setup()
    f.emit("suspended", { threadId: "OTHER", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    f.emit("modeChanged", { threadId: "OTHER", modeId: "terse", previousModeId: "chat" })
    expect(client.getSnapshot().pendingAsk).toBeNull()
    expect(client.getSnapshot().modeId).toBeNull()
  })

  it("StrictMode cycle: close() during an in-flight connect() abandons wire A and lives on wire B", async () => {
    // Each connect() gets its OWN wire (factory seam) — like production, where
    // every connect constructs a fresh super-line client. A's join blocks until
    // released, so close() lands while the first connect is mid-handshake.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const wireA = fakeWire({
      join: async () => {
        await gate
        return { ok: true }
      },
    })
    const wireB = fakeWire()
    const instances = [wireA, wireB]
    const client = createHarnessClient({ url: "ws://test", threadId: "t1", wire: () => instances.shift()!.wire })
    clients.push(client)

    const first = client.connect() // mount → wire A, join parked
    client.close() //                 StrictMode unmount mid-handshake
    const second = client.connect() // remount → wire B, must not be blocked
    release()
    await Promise.all([first, second])

    expect((wireA.raw as { connected: boolean }).connected).toBe(false) // A was closed
    expect(client.getSnapshot().connected).toBe(true) // B's session is live

    // the abandoned A must have NO tree subscription; B's is the live one
    writeTree(wireA, "t1", ["rA"], { rA: node({ nodeId: "rA", text: "ghost", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual([])
    writeTree(wireB, "t1", ["rB"], { rB: node({ nodeId: "rB", text: "hi", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual(["rB"])
  })

  it("switchThread detaches the old subscription BEFORE joining — a stale write mid-join is inert", async () => {
    let releaseJoin!: () => void
    let joins = 0
    const f = fakeWire({
      join: async () => {
        // first join (connect) resolves; the switchThread join parks
        if (++joins < 2) return { ok: true }
        await new Promise<void>((r) => (releaseJoin = r))
        return { ok: true }
      },
    })
    const client = createHarnessClient({ url: "ws://test", threadId: "t1", wire: f.wire })
    clients.push(client)
    await client.connect()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "old", status: "complete" }) })
    const oldThreadHandle = f.handle("thread", "t1")
    const oldNodeHandle = f.handle("node", "r1")

    const switching = client.switchThread("t2") // join for t2 is parked
    // stale old-thread writes land DURING the switch — the early detach must eat them
    oldThreadHandle.write({ turns: ["r1"], nodes: { r1: { parentNodeId: null, depth: 0, childOrder: [] } } })
    oldNodeHandle.write(node({ nodeId: "r1", text: "zombie" }))
    expect(client.getSnapshot().threadId).toBe("t2")
    expect(client.getSnapshot().tree.turns).toEqual([])

    releaseJoin()
    await switching
    writeTree(f, "t2", ["r2"], { r2: node({ nodeId: "r2", text: "new", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual(["r2"])
  })
})
