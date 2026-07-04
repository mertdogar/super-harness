// OpenTUI cockpit: a topbar (thread left / connection right), a scrolling
// transcript of blocks (your message / a turn's node tree / system notices), a
// docked ask_user prompt while suspended, a one-line live status, and the input.
// Type-and-Enter sends; `/`-lines are commands; while suspended the docked
// <select> is focused (Tab toggles to the input). Renders the assembled ClientTree
// straight from the Store (subscribeTree) — no client-side reduce.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { emptyTree, type ClientTree } from "@super-harness/shared"
import { HarnessSession, type Pending } from "./session"
import { dispatch } from "./dispatch"
import { TurnView } from "./node-view"
import { QuestionDock } from "./ask-user"
import { COLORS } from "./theme"
import type { HarnessConfig } from "./config"

type Conn = "connecting" | "connected" | "disconnected"

type Block = { kind: "user"; text: string } | { kind: "turn"; rootId: string } | { kind: "system"; text: string }

// Append a turn block for any root that appeared in the tree but isn't shown yet.
function withNewTurns(blocks: Block[], turns: string[]): Block[] {
  const shown = new Set(blocks.filter((b): b is { kind: "turn"; rootId: string } => b.kind === "turn").map((b) => b.rootId))
  const fresh = turns.filter((id) => !shown.has(id))
  return fresh.length === 0 ? blocks : [...blocks, ...fresh.map((rootId) => ({ kind: "turn" as const, rootId }))]
}

function connView(conn: Conn): { glyph: string; text: string; color: string } {
  if (conn === "connected") return { glyph: "●", text: "connected", color: COLORS.green }
  if (conn === "disconnected") return { glyph: "◌", text: "reconnecting…", color: COLORS.yellow }
  return { glyph: "◌", text: "connecting…", color: COLORS.yellow }
}

function Topbar({ session, conn, host, tokens }: { session: HarnessSession; conn: Conn; host: string; tokens: number }) {
  const right = connView(conn)
  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.dim}>{`thread ${session.threadId}`}</text>
      <box flexGrow={1} />
      {tokens > 0 ? <text fg={COLORS.dim}>{`${fmtTokens(tokens)} tok  `}</text> : null}
      <text fg={right.color}>{`${right.glyph} ${right.text}  `}</text>
      <text fg={COLORS.dim}>{host}</text>
    </box>
  )
}

// Cumulative conversation token total (tree.usage.totalTokens), compact.
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function renderBlock(block: Block, index: number, tree: ClientTree, live: boolean, full: boolean) {
  if (block.kind === "user") {
    return (
      <box key={index} flexDirection="column" paddingTop={1}>
        <text fg={COLORS.accent}>▌ you</text>
        <text fg={COLORS.text}>{block.text}</text>
      </box>
    )
  }
  if (block.kind === "system") {
    return <text key={index} fg={COLORS.dim}>{`· ${block.text}`}</text>
  }
  const root = tree.nodes[block.rootId]
  if (!root) return null
  return <TurnView key={index} tree={tree} root={root} live={live} full={full} />
}

function Cockpit({ session }: { session: HarnessSession }) {
  const { width, height } = useTerminalDimensions()
  const host = useMemo(() => {
    try {
      return new URL(session.config.url).host
    } catch {
      return session.config.url
    }
  }, [session])

  const [tree, setTree] = useState<ClientTree>(emptyTree())
  const [blocks, setBlocks] = useState<Block[]>([])
  const [conn, setConn] = useState<Conn>("connecting")
  const [statusLine, setStatusLine] = useState("connecting…")
  const [input, setInput] = useState("")
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [focus, setFocus] = useState<"input" | "select">("input")

  useEffect(() => {
    const pushSystem = (text: string) => setBlocks((prev) => [...prev, { kind: "system", text }])
    session.setHandlers({
      onEvent: () => {},
      onTree: (next) => {
        setTree(next)
        setBlocks((prev) => withNewTurns(prev, next.turns))
      },
      onLine: (line) => pushSystem(line),
      onStatus: (status) => {
        switch (status.kind) {
          case "ready":
            setConn("connected")
            setStatusLine("connected")
            return
          case "turn_start":
            setBusy(true)
            setStatusLine(`turn ${status.runId.slice(0, 8)} · running`)
            return
          case "turn_done":
            setBusy(false)
            setStatusLine(`done · ${status.tools} tools · ${status.errors} err · ${status.tokens} tok`)
            return
          case "suspended":
            setPending(session.pending)
            setFocus("select")
            setStatusLine("waiting for your answer")
            return
          case "approval_required":
            setStatusLine(`approval needed: ${status.toolName} — /approve, /deny or /always`)
            pushSystem(`approval needed: ${status.toolName} ${JSON.stringify(status.args)} — /approve, /deny or /always`)
            return
          case "error":
            setBusy(false)
            setStatusLine(`ERR: ${status.message}`)
            pushSystem(`ERR: ${status.message}`)
            return
          case "disconnected":
            setConn("disconnected")
            setBusy(false)
            setPending(null)
            setStatusLine("disconnected — reconnecting…")
            return
          case "reconnected":
            setConn("connected")
            setStatusLine("reconnected")
            return
          case "info":
            setStatusLine(status.message)
            pushSystem(status.message)
            return
        }
      },
    })
    void session.connect()
    return () => session.close()
  }, [session])

  useKeyboard((key) => {
    if (key.eventType !== "press") return
    if (key.name === "tab" && pending) setFocus((f) => (f === "select" ? "input" : "select"))
  })

  const startTurn = (text: string) => {
    if (!session.isConnected) {
      setStatusLine("not connected")
      return
    }
    // Sending while a turn runs is fine — the server queues it as a follow-up.
    setBlocks((prev) => [...prev, { kind: "user", text }])
    void session.send(text)
  }

  const answer = (value: string) => {
    setPending(null)
    setFocus("input")
    void session.reply(value)
  }

  const submit = (value: unknown) => {
    const text = (typeof value === "string" ? value : input).trim()
    setInput("")
    if (!text) return
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ")
      const cmd = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase()
      const arg = sp === -1 ? "" : text.slice(sp + 1).trim()
      if (cmd === "send") {
        if (arg) startTurn(arg)
        return
      }
      if (cmd === "reply") {
        if (arg) answer(arg)
        return
      }
      void dispatch(session, text).then((result) => {
        if (result === "quit") process.exit(0)
      })
      return
    }
    if (pending) answer(text)
    else startTurn(text)
  }

  let lastTurn = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === "turn") {
      lastTurn = i
      break
    }
  }

  const placeholder = pending
    ? focus === "input"
      ? "type your answer…"
      : "Tab to type a custom answer"
    : busy
      ? "(turn running) /command…"
      : "type a message · /help"

  return (
    <box flexDirection="column" width={width} height={height}>
      <Topbar session={session} conn={conn} host={host} tokens={tree.usage?.totalTokens ?? 0} />
      <scrollbox scrollY stickyScroll stickyStart="bottom" flexGrow={1} paddingLeft={1} paddingRight={1}>
        {blocks.map((block, i) => renderBlock(block, i, tree, i === lastTurn && busy, session.config.full))}
      </scrollbox>
      {pending ? (
        <QuestionDock pending={pending} focused={focus === "select"} onPick={answer} onFreeform={() => setFocus("input")} />
      ) : null}
      <box height={1} paddingLeft={1}>
        <text fg={COLORS.dim}>{statusLine}</text>
      </box>
      <box borderStyle="rounded" border borderColor={pending ? COLORS.yellow : COLORS.accent}>
        <input
          value={input}
          onInput={(value: string) => setInput(value)}
          onSubmit={submit}
          placeholder={placeholder}
          focused={!pending || focus === "input"}
        />
      </box>
    </box>
  )
}

export async function runTui(config: HarnessConfig): Promise<void> {
  const { createCliRenderer } = await import("@opentui/core")
  const { createRoot } = await import("@opentui/react")
  const session = new HarnessSession(config)
  const renderer = await createCliRenderer({ exitOnCtrlC: true, screenMode: "alternate-screen" })
  createRoot(renderer).render(<Cockpit session={session} />)
  process.on("exit", () => {
    process.stdout.write(`\nresume this session:\n  ${session.resumeCommand()}\n`)
  })
}
