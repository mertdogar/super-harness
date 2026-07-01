// Headless shell: no OpenTUI, one line per event / status on stdout. Status
// transitions are greppable <<MARKER ...>> lines so an agent piping into this
// knows exactly when to act. Input is stdin (quits on EOF) or a control FIFO
// (--control <path>): the FIFO is reopened after each writer, so an agent drives a
// long-lived session with repeated `echo "/send …" > <path>` and only /quit exits.
//
// diffTree emits text/reasoning as deltas; a small coalescer buffers them per node
// and flushes one *_done block before any non-delta event, so the trace reads like
// omma's (one clean text:/think: line per block, interleaved with tools).

import * as readline from "node:readline"
import { createReadStream, existsSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import type { HarnessEvent } from "@super-harness/shared"
import { HarnessSession, type Status } from "./session"
import { dispatch } from "./dispatch"
import { formatEvent } from "./format"
import type { HarnessConfig } from "./config"

function marker(status: Status): string {
  switch (status.kind) {
    case "ready":
      return "<<READY>>"
    case "turn_start":
      return `<<TURN_START runId=${status.runId}>>`
    case "turn_done":
      return `<<TURN_DONE tools=${status.tools} errors=${status.errors} tokens=${status.tokens}>>`
    case "suspended":
      return `<<SUSPENDED tool=${status.toolName} request=${JSON.stringify(status.request)}${
        status.resumeSchema ? ` schema=${status.resumeSchema}` : ""
      }>>`
    case "error":
      return `<<ERROR ${status.message}>>`
    case "disconnected":
      return "<<DISCONNECTED>>"
    case "reconnected":
      return "<<RECONNECTED>>"
    case "info":
      return `<<INFO ${status.message}>>`
  }
}

type Envelope = { nodeId: string; parentNodeId: string | null; depth: number; agentType?: string }

// Coalesces consecutive text/reasoning deltas (one active block at a time — the
// linear stream only grows one node's text at once) into *_done events.
function makeCoalescer(sink: (event: HarnessEvent) => void) {
  let active: { env: Envelope; text: string; reasoning: string } | null = null
  const flush = () => {
    if (!active) return
    const { env, reasoning, text } = active
    active = null
    if (reasoning) sink({ ...env, type: "reasoning_done", text: reasoning })
    if (text) sink({ ...env, type: "text_done", text })
  }
  return (event: HarnessEvent) => {
    if (event.type === "text_delta" || event.type === "reasoning_delta") {
      if (active && active.env.nodeId !== event.nodeId) flush()
      if (!active) {
        active = {
          env: { nodeId: event.nodeId, parentNodeId: event.parentNodeId, depth: event.depth, agentType: event.agentType },
          text: "",
          reasoning: "",
        }
      }
      if (event.type === "text_delta") active.text += event.text
      else active.reasoning += event.text
      return
    }
    flush()
    sink(event)
  }
}

async function pumpControl(path: string, session: HarnessSession): Promise<void> {
  if (!existsSync(path)) execFileSync("mkfifo", [path])
  else if (!statSync(path).isFIFO()) {
    process.stdout.write(`<<ERROR --control path exists and is not a FIFO: ${path}>>\n`)
    process.exit(2)
  }
  for (;;) {
    const stream = createReadStream(path, { encoding: "utf8" })
    const rl = readline.createInterface({ input: stream, terminal: false })
    for await (const line of rl) {
      if ((await dispatch(session, line)) === "quit") {
        rl.close()
        stream.close()
        return
      }
    }
    rl.close()
    stream.close()
  }
}

async function pumpStdin(session: HarnessSession): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    if ((await dispatch(session, line)) === "quit") break
  }
}

export async function runHeadless(config: HarnessConfig): Promise<void> {
  const session = new HarnessSession(config)
  const toolNames = new Map<string, string>()
  let seq = 0
  const print = (event: HarnessEvent) => {
    const line = formatEvent(event, config, toolNames, seq++)
    if (line !== null) for (const l of line.split("\n")) process.stdout.write(`${l}\n`)
  }
  const coalesce = makeCoalescer(print)

  session.setHandlers({
    onEvent: (event) => {
      if (config.json) {
        process.stdout.write(`${JSON.stringify(event)}\n`)
        return
      }
      coalesce(event)
    },
    onTree: () => {},
    onLine: (line) => process.stdout.write(`${line}\n`),
    onStatus: (status) => process.stdout.write(`${marker(status)}\n`),
  })

  if (!config.json) process.stdout.write(`<<SPILL dir=${config.spillDir}>>\n`)

  try {
    await session.connect()
  } catch (error) {
    process.stdout.write(`<<ERROR ${error instanceof Error ? error.message : String(error)}>>\n`)
    process.exit(1)
  }

  if (config.control) {
    process.stdout.write(`<<CONTROL fifo=${config.control}>>\n`)
    await pumpControl(config.control, session)
  } else {
    await pumpStdin(session)
  }

  session.close()
  process.exit(0)
}
