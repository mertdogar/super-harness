// Shared slash-command parser. Both shells route a `/cmd arg` line through here;
// the TUI additionally maps a bare line to send/reply before calling this.

import type { HarnessSession } from "./session"

export type DispatchResult = "quit" | void

const HELP = [
  "/send <text>      start a turn",
  "/reply <text>     answer a pending ask_user (yes/y for approvals)",
  "/abort            abort the running turn",
  "/session          print thread / connection info",
  "/new [threadId]   start a fresh thread",
  "/help             this list",
  "/quit             disconnect and exit",
].join("\n")

export async function dispatch(session: HarnessSession, raw: string): Promise<DispatchResult> {
  const line = raw.trim()
  if (!line) return
  if (!line.startsWith("/")) {
    session.info("commands start with '/': try /send <text> or /reply <text>")
    return
  }
  const space = line.indexOf(" ")
  const cmd = (space === -1 ? line.slice(1) : line.slice(1, space)).toLowerCase()
  const arg = space === -1 ? "" : line.slice(space + 1).trim()

  switch (cmd) {
    case "send":
      await session.send(arg)
      return
    case "reply":
      await session.reply(arg)
      return
    case "abort":
      await session.abort()
      return
    case "session":
      session.printSession()
      return
    case "new":
      session.newThread(arg || undefined)
      return
    case "help":
      session.line(HELP)
      return
    case "quit":
    case "exit":
      return "quit"
    default:
      session.info(`unknown command: /${cmd} (try /help)`)
      return
  }
}
