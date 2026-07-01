// HarnessEvent -> one transcript line (or null to skip), for the headless shell.
// The TUI renders the tree directly; only headless formats events. Reasoning +
// text render as *_done blocks (the headless coalesces diffTree's deltas into
// them). Big payloads spill to a file and render as a `→ <path>` pointer; images
// decode from base64 to a real file. ASCII only so piped stdout stays clean.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { HarnessEvent } from "@super-harness/shared"

export interface FormatOpts {
  verbose: boolean
  full: boolean
  spillDir: string
}

const INLINE_LIMIT = 1200
const indent = (depth: number): string => "  ".repeat(Math.max(0, depth))

let spillDirReady = false
function spill(file: string, data: string | Buffer): void {
  if (!spillDirReady) {
    mkdirSync(dirname(file), { recursive: true })
    spillDirReady = true
  }
  writeFileSync(file, data)
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function asImageMedia(value: unknown): { mediaType: string; data: string; text?: string } | null {
  if (typeof value !== "object" || value === null) return null
  const o = value as { __workspaceMedia?: unknown; mediaType?: unknown; data?: unknown; text?: unknown }
  if (o.__workspaceMedia !== true) return null
  if (typeof o.mediaType !== "string" || !o.mediaType.startsWith("image/")) return null
  if (typeof o.data !== "string") return null
  return { mediaType: o.mediaType, data: o.data, text: typeof o.text === "string" ? o.text : undefined }
}

// Render a tool arg/result/task: image -> decoded file pointer; oversized ->
// spilled file pointer; otherwise inline. `seq` + `hint` name the spill file.
function render(value: unknown, seq: number, hint: string, opts: FormatOpts): string {
  const image = asImageMedia(value)
  if (image) {
    const ext = image.mediaType.split("/")[1] ?? "bin"
    const file = join(opts.spillDir, `${seq}-${hint}.${ext}`)
    const bytes = Buffer.from(image.data, "base64")
    spill(file, bytes)
    const label = image.text ? image.text.split(" (")[0] : "image"
    return `[image ${label} -> ${file} (${kb(bytes.length)})]`
  }

  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) return ""
  if (opts.full || text.length <= INLINE_LIMIT) return text

  const file = join(opts.spillDir, `${seq}-${hint}.txt`)
  spill(file, text)
  const head = text.slice(0, 200).replace(/\s+/g, " ").trim()
  return `${head}… [+${kb(text.length)} -> ${file}]`
}

// `toolNames` threads the tool name from tool_start to tool_end (which carries
// only toolCallId). `seq` names spill files uniquely. Caller owns both.
export function formatEvent(
  event: HarnessEvent,
  opts: FormatOpts,
  toolNames: Map<string, string>,
  seq: number,
): string | null {
  const pad = indent(event.depth)
  switch (event.type) {
    case "node_start":
      return `${pad}node> ${event.agentType ?? "agent"}${
        event.task ? `: ${render(event.task, seq, "task", opts)}` : ""
      }${opts.verbose && event.modelId ? ` [${event.modelId}]` : ""}`
    case "node_end": {
      const tokens = event.usage?.totalTokens ? ` ${event.usage.totalTokens}tok` : ""
      const dur = event.durationMs ? ` ${event.durationMs}ms` : ""
      return `${pad}node< ${event.agentType ?? "agent"} ${event.reason}${tokens}${dur}`
    }
    case "tool_input_start":
      toolNames.set(event.toolCallId, event.toolName)
      return opts.verbose ? `${pad}  tool? ${event.toolName}` : null
    case "tool_start":
      toolNames.set(event.toolCallId, event.toolName)
      return `${pad}  tool> ${event.toolName} ${render(event.args, seq, event.toolName, opts)}`
    case "tool_end": {
      const name = toolNames.get(event.toolCallId) ?? event.toolCallId
      return `${pad}  tool< ${name} ${event.isError ? "ERROR" : "ok"} ${render(event.result, seq, name, opts)}`
    }
    case "reasoning_done":
      return event.text.trim() ? `${pad}  think: ${event.text}` : null
    case "text_done":
      return event.text.trim() ? `${pad}  text: ${event.text}` : null
    case "error":
      return `${pad}  ERR: ${event.message}`
    case "todo":
      return `${pad}  todo: ${event.items
        .map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.content}`)
        .join("  ")}`
    default:
      return null
  }
}
