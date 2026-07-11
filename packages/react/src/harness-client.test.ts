import { afterEach, describe, expect, it, vi } from "vitest"
import type { NodeRow, NodeState, ThreadRow, ToolRow } from "@super-harness/shared"
import { createHarnessClient, type HarnessClient, type HarnessClientConfig } from "./harness-client"

// ── fake wire ─────────────────────────────────────────────────────────────────
// Structural stand-in for the super-line client: request methods, room-event
// handlers (on/emit), and contract COLLECTIONS (collection().subscribe()) that
// subscribeTree + the sidebar drive. Rows are pushed via putRow/delRow.

function fakeWire(overrides: Record<string, unknown> = {}) {
  const cols = new Map<string, Map<string, { id: string }>>()
  const colSubs = new Map<string, Set<(ev?: { type: string; id: string }) => void>>()
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  const calls: Record<string, number> = {}
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const colMap = (n: string) => cols.get(n) ?? (cols.set(n, new Map()), cols.get(n)!)
  const notify = (n: string, ev: { type: string; id: string }) => {
    for (const cb of colSubs.get(n) ?? []) cb(ev)
  }
  // Interpret only a single `eq` filter — all subscribeTree/sidebar queries use one.
  const applyFilter = (rows: { id: string }[], query: unknown) => {
    const f = (query as { filter?: { op: string; field: string; value: unknown } })?.filter
    if (!f || f.op !== "eq") return rows
    return rows.filter((r) => (r as Record<string, unknown>)[f.field] === f.value)
  }
  const wire = {
    connected: true,
    "harness.join": async () => (count("join"), { ok: true }),
    "harness.sendMessage": async () => (count("sendMessage"), { ok: true }),
    "harness.resumeMessage": async () => (count("resumeMessage"), { ok: true }),
    "harness.abort": async () => (count("abort"), { ok: true }),
    "harness.respondToApproval": async () => (count("respondToApproval"), { ok: true }),
    "harness.switchMode": async () => (count("switchMode"), { ok: true }),
    "harness.listModes": async () => (count("listModes"), { modes: [], defaultModeId: undefined }),
    "harness.listThreads": async () => (count("listThreads"), { threads: [] }),
    "harness.createThread": async () => (count("createThread"), { threadId: "fresh-thread" }),
    "harness.deleteThread": async () => (count("deleteThread"), { ok: true }),
    on: (name: string, cb: (p: unknown) => void) => {
      let set = handlers.get(name)
      if (!set) handlers.set(name, (set = new Set()))
      set.add(cb)
      return () => set.delete(cb)
    },
    collection: (n: string) => ({
      subscribe: (query?: unknown) => ({
        rows: () => applyFilter([...colMap(n).values()], query),
        subscribe: (cb: (ev?: { type: string; id: string }) => void) => {
          let set = colSubs.get(n)
          if (!set) colSubs.set(n, (set = new Set()))
          set.add(cb)
          return () => set!.delete(cb)
        },
        ready: Promise.resolve(),
      }),
    }),
    close: () => {
      wire.connected = false
      handlers.clear()
      colSubs.clear()
    },
    ...overrides,
  }
  return {
    wire: wire as unknown as WireInstance,
    raw: wire,
    calls,
    emit: (name: string, p: unknown) => {
      for (const cb of handlers.get(name) ?? []) cb(p)
    },
    putRow: (n: string, row: { id: string }) => {
      colMap(n).set(row.id, row)
      notify(n, { type: "update", id: row.id })
    },
    delRow: (n: string, id: string) => {
      colMap(n).delete(id)
      notify(n, { type: "delete", id })
    },
  }
}

type WireInstance = Exclude<NonNullable<HarnessClientConfig["client"]>, (...args: never) => unknown>
type Fake = ReturnType<typeof fakeWire>

function node(partial: Partial<NodeState> & { nodeId: string }): NodeState {
  return { parentNodeId: null, depth: 0, status: "running", reasoning: "", text: "", toolOrder: [], tools: {}, childOrder: [], ...partial }
}

function threadRow(id: string, turns: string[], extra: Partial<ThreadRow> = {}): ThreadRow {
  return { id, resourceId: id, turns, todos: [], createdAt: 1, updatedAt: 1, ...extra }
}

// Write the thread row + node rows + tool rows the way the server's writer would.
function writeTree(f: Fake, threadId: string, turns: string[], nodes: Record<string, NodeState>) {
  f.putRow("harness.threads", threadRow(threadId, turns))
  for (const [id, n] of Object.entries(nodes)) {
    const nr: NodeRow = {
      id,
      threadId,
      parentNodeId: n.parentNodeId,
      depth: n.depth,
      agentType: n.agentType,
      task: n.task,
      status: n.status,
      reasoning: n.reasoning,
      text: n.text,
      toolOrder: n.toolOrder,
      childOrder: n.childOrder,
      usage: n.usage,
      durationMs: n.durationMs,
      error: n.error,
      textOffset: n.textOffset,
    }
    f.putRow("harness.nodes", nr)
    for (const tid of n.toolOrder) {
      const t = n.tools[tid]
      const tr: ToolRow = {
        id: t.toolCallId,
        threadId,
        nodeId: id,
        toolName: t.toolName,
        status: t.status,
        argsText: t.argsText,
        args: t.args,
        result: t.result,
        isError: t.isError,
        textOffset: t.textOffset,
      }
      f.putRow("harness.tools", tr)
    }
  }
}

const clients: HarnessClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

async function setup(overrides: Record<string, unknown> = {}) {
  const f = fakeWire(overrides)
  const client = createHarnessClient({ threadId: "t1", client: f.wire })
  clients.push(client)
  await client.connect()
  return { f, client }
}

const ASK = { toolCallId: "a1", toolName: "ask_user", status: "input-available" as const, argsText: "", args: { question: "which city?" } }

describe("HarnessClient state machine", () => {
  it("derives busy from the last root", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "working" }) })
    expect(client.getSnapshot().busy).toBe(true)

    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "done", status: "complete" }) })
    expect(client.getSnapshot().busy).toBe(false)
  })

  it("infers a pending ask from the tree (refresh mid-suspension) and reads it as not-busy", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", toolOrder: ["a1"], tools: { a1: { ...ASK } } }) })
    const s = client.getSnapshot()
    expect(s.pendingAsk).toMatchObject({ toolCallId: "a1", request: { question: "which city?" } })
    expect(s.busy).toBe(false)

    writeTree(f, "t1", ["r1"], {
      r1: node({ nodeId: "r1", status: "complete", toolOrder: ["a1"], tools: { a1: { ...ASK, status: "output-available", result: "Izmir" } } }),
    })
    expect(client.getSnapshot().pendingAsk).toBeNull()
  })

  it("ignores a stale still-running earlier root — only the LAST turn can ask", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1", "r2"], {
      r1: node({ nodeId: "r1", toolOrder: ["a1"], tools: { a1: { ...ASK } } }),
      r2: node({ nodeId: "r2", text: "new turn" }),
    })
    const s = client.getSnapshot()
    expect(s.pendingAsk).toBeNull()
    expect(s.busy).toBe(true)
  })

  it("keeps the prompt and sets a notice when reply is rejected (ok:false)", async () => {
    const ok = { value: false }
    const { f, client } = await setup({ "harness.resumeMessage": async () => ({ ok: ok.value }) })
    f.emit("harness.suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: { question: "q" } })
    expect(client.getSnapshot().pendingAsk).not.toBeNull()

    await client.reply("Izmir")
    expect(client.getSnapshot().pendingAsk).not.toBeNull()
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
    f.emit("harness.suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    expect(client.getSnapshot().busy).toBe(false)
    expect(client.getSnapshot().pendingAsk).toMatchObject({ toolCallId: "a1" })
  })

  it("abort clears busy/pendings/queue locally (tui parity)", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "running" }) })
    f.emit("harness.approvalRequired", { threadId: "t1", nodeId: "r1", toolCallId: "g1", toolName: "send_report", args: {} })
    f.emit("harness.followUpQueued", { threadId: "t1", count: 2 })
    expect(client.getSnapshot().busy).toBe(true)
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
      r1: node({ nodeId: "r1", toolOrder: ["g1"], tools: { g1: { toolCallId: "g1", toolName: "send_report", status: "input-available", argsText: "", args: {} } } }),
    })
    f.emit("harness.approvalRequired", { threadId: "t1", nodeId: "r1", toolCallId: "g1", toolName: "send_report", args: {} })
    expect(client.getSnapshot().pendingApproval).toMatchObject({ toolCallId: "g1" })

    writeTree(f, "t1", ["r1"], {
      r1: node({ nodeId: "r1", status: "complete", toolOrder: ["g1"], tools: { g1: { toolCallId: "g1", toolName: "send_report", status: "output-available", argsText: "", result: { delivered: true } } } }),
    })
    expect(client.getSnapshot().pendingApproval).toBeNull()
  })

  it("dismissAsk drops a prompt the server no longer knows about", async () => {
    const { f, client } = await setup()
    f.emit("harness.suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    client.dismissAsk()
    expect(client.getSnapshot().pendingAsk).toBeNull()
  })

  it("filters room events by the active thread", async () => {
    const { f, client } = await setup()
    f.emit("harness.suspended", { threadId: "OTHER", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    f.emit("harness.modeChanged", { threadId: "OTHER", modeId: "terse", previousModeId: "chat" })
    expect(client.getSnapshot().pendingAsk).toBeNull()
    expect(client.getSnapshot().modeId).toBeNull()
  })

  it("the sidebar reflects the harness.threads collection, newest-updated first", async () => {
    const { f, client } = await setup()
    f.putRow("harness.threads", threadRow("t1", [], { updatedAt: 1 }))
    f.putRow("harness.threads", threadRow("t2", [], { updatedAt: 2, title: "Trip" }))
    expect(client.getSnapshot().threads.map((t) => t.id)).toEqual(["t2", "t1"])
    expect(client.getSnapshot().threads.find((t) => t.id === "t2")?.title).toBe("Trip")
  })

  it("a title update on a thread row patches the sidebar in place", async () => {
    const { f, client } = await setup()
    f.putRow("harness.threads", threadRow("t1", [], { updatedAt: 1 }))
    f.putRow("harness.threads", threadRow("other", [], { updatedAt: 2 }))
    f.putRow("harness.threads", threadRow("other", [], { updatedAt: 3, title: "New Title" }))
    expect(client.getSnapshot().threads.map((t) => t.id)).toEqual(["other", "t1"])
    expect(client.getSnapshot().threads.find((t) => t.id === "other")?.title).toBe("New Title")
  })

  it("deleting a background thread drops it; the active view is untouched", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "hi", status: "complete" }) })
    f.putRow("harness.threads", threadRow("other", []))
    expect(client.getSnapshot().threads.map((t) => t.id).sort()).toEqual(["other", "t1"])

    f.delRow("harness.threads", "other")
    expect(client.getSnapshot().threads.map((t) => t.id)).toEqual(["t1"])
    expect(client.getSnapshot().activeThreadDeleted).toBe(false)
    expect(client.getSnapshot().tree.turns).toEqual(["r1"])
  })

  it("deleting the ACTIVE thread flips activeThreadDeleted and blanks the view", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "hi", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual(["r1"])
    expect(client.getSnapshot().threads.map((t) => t.id)).toEqual(["t1"])

    f.delRow("harness.threads", "t1") // the active thread, deleted elsewhere

    const s = client.getSnapshot()
    expect(s.activeThreadDeleted).toBe(true)
    expect(s.threads.map((t) => t.id)).toEqual([])
    expect(s.tree.turns).toEqual([])
    expect(s.busy).toBe(false)
  })

  it("switchThread clears the activeThreadDeleted limbo", async () => {
    const { f, client } = await setup()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", status: "complete" }) })
    f.delRow("harness.threads", "t1")
    expect(client.getSnapshot().activeThreadDeleted).toBe(true)

    await client.switchThread("t2")
    expect(client.getSnapshot().activeThreadDeleted).toBe(false)
    expect(client.getSnapshot().threadId).toBe("t2")
  })

  it("StrictMode cycle: close() during an in-flight connect() abandons wire A and lives on wire B", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const wireA = fakeWire({
      "harness.join": async () => {
        await gate
        return { ok: true }
      },
    })
    const wireB = fakeWire()
    const instances = [wireA, wireB]
    const client = createHarnessClient({ threadId: "t1", client: () => instances.shift()!.wire })
    clients.push(client)

    const first = client.connect()
    client.close()
    const second = client.connect()
    release()
    await Promise.all([first, second])

    expect((wireA.raw as { connected: boolean }).connected).toBe(false)
    expect(client.getSnapshot().connected).toBe(true)

    writeTree(wireA, "t1", ["rA"], { rA: node({ nodeId: "rA", text: "ghost", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual([])
    writeTree(wireB, "t1", ["rB"], { rB: node({ nodeId: "rB", text: "hi", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual(["rB"])
  })

  it("borrowed StrictMode cycle: close() mid-connect leaves ONE poll and no duplicate rows", async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let joins = 0
      const f = fakeWire({
        "harness.join": async () => {
          if (++joins === 1) await gate
          return { ok: true }
        },
      })
      const client = createHarnessClient({ threadId: "t1", client: f.wire })
      clients.push(client)

      const first = client.connect()
      client.close()
      const second = client.connect()
      release()
      await Promise.all([first, second])
      expect(client.getSnapshot().connected).toBe(true)

      // one row per thread — a leaked subscription can't double it (keyed by id)
      f.putRow("harness.threads", threadRow("tX", []))
      expect(client.getSnapshot().threads.filter((t) => t.id === "tX")).toHaveLength(1)

      // one reconnect poll — a leaked one would re-join twice per recovery
      ;(f.raw as { connected: boolean }).connected = false
      await vi.advanceTimersByTimeAsync(1000)
      ;(f.raw as { connected: boolean }).connected = true
      const before = joins
      await vi.advanceTimersByTimeAsync(1000)
      expect(joins).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("in activeThreadDeleted limbo the poll does NOT re-join (a re-join would resurrect the purged thread)", async () => {
    vi.useFakeTimers()
    try {
      let joins = 0
      const f = fakeWire({ "harness.join": async () => (joins++, { ok: true }) })
      const client = createHarnessClient({ threadId: "t1", client: f.wire })
      clients.push(client)
      await client.connect()
      writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", status: "complete" }) })
      f.delRow("harness.threads", "t1") // active thread → limbo
      expect(client.getSnapshot().activeThreadDeleted).toBe(true)

      const before = joins
      ;(f.raw as { connected: boolean }).connected = false
      await vi.advanceTimersByTimeAsync(1000)
      ;(f.raw as { connected: boolean }).connected = true
      await vi.advanceTimersByTimeAsync(1000)
      expect(joins).toBe(before)
      expect(client.getSnapshot().connected).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("borrowed client: close() detaches the harness listeners but never closes the host's client", async () => {
    const f = fakeWire()
    const client = createHarnessClient({ threadId: "t1", client: f.wire })
    await client.connect()

    client.close()
    expect((f.raw as { connected: boolean }).connected).toBe(true)

    f.emit("harness.suspended", { threadId: "t1", nodeId: "r1", toolCallId: "a1", toolName: "ask_user", request: "q" })
    expect(client.getSnapshot().pendingAsk).toBeNull()
  })

  it("switchThread detaches the old subscription BEFORE joining — a stale write mid-join is inert", async () => {
    let releaseJoin!: () => void
    let joins = 0
    const f = fakeWire({
      "harness.join": async () => {
        if (++joins < 2) return { ok: true }
        await new Promise<void>((r) => (releaseJoin = r))
        return { ok: true }
      },
    })
    const client = createHarnessClient({ threadId: "t1", client: f.wire })
    clients.push(client)
    await client.connect()
    writeTree(f, "t1", ["r1"], { r1: node({ nodeId: "r1", text: "old", status: "complete" }) })

    const switching = client.switchThread("t2")
    // stale old-thread write lands DURING the switch — the early detach must eat it
    f.putRow("harness.nodes", { id: "r1", threadId: "t1", parentNodeId: null, depth: 0, status: "running", reasoning: "", text: "zombie", toolOrder: [], childOrder: [] } as NodeRow)
    expect(client.getSnapshot().threadId).toBe("t2")
    expect(client.getSnapshot().tree.turns).toEqual([])

    releaseJoin()
    await switching
    writeTree(f, "t2", ["r2"], { r2: node({ nodeId: "r2", text: "new", status: "complete" }) })
    expect(client.getSnapshot().tree.turns).toEqual(["r2"])
  })

  it("send forwards file attachments to the wire, including attachment-only sends", async () => {
    const sent: unknown[] = []
    const { client } = await setup({
      "harness.sendMessage": async (input: unknown) => (sent.push(input), { ok: true }),
    })
    const png = { url: "data:image/png;base64,AAAA", mimeType: "image/png" }
    await client.send("what is this?", [png])
    expect(sent[0]).toMatchObject({ threadId: "t1", message: "what is this?", files: [png] })

    await client.send("", [png]) // attachments count as content
    expect(sent[1]).toMatchObject({ threadId: "t1", message: "", files: [png] })

    await client.send("") // nothing at all still short-circuits
    expect(sent).toHaveLength(2)
  })
})
