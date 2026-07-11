---
name: tui
description: Drive the @super-harness/tui terminal client to debug a super-harness agent turn from the terminal (headless, no browser) — send a message, watch the streamed node-tree of tools/reasoning/errors, answer ask_user suspensions, abort a turn. Use when debugging the supervisor + its subagents, reproducing or bisecting a turn, checking a tool's args/result, or when the user mentions the tui, packages/tui, headless agent turns, or testing a super-harness server over super-line. It reads the tree from the durable Store the server writes (subscribeTree), so it exercises the exact transport real clients use.
---

# tui — drive a super-harness agent turn from the terminal

`packages/tui/` (`@super-harness/tui`) is a Bun client that connects over **super-line** to a running super-harness server and renders one turn as a node-tree. It reads the tree from the per-node/thread **Store** (not an event stream) via `subscribeTree`, so it tests the real client path. Two shells: an OpenTUI cockpit (humans) and a greppable `--headless` stdout pipe (agents). See [EXAMPLES.md](EXAMPLES.md) for copy-paste recipes.

## When to use it
- Reproduce / debug a chat turn (supervisor + delegated subagents) without a browser.
- Inspect a tool's exact `args` and `result`, watch reasoning/text, see where a turn suspends or fails.
- Verify a fix end-to-end (suspend→resume via `ask_user`, a tool change) against a running server.

## Prerequisites
- **A running super-harness server** you point at with `--url` (default `ws://localhost:4111/super-line`). The harness is client-only — it does not start a server. Bring up your own `createHarness(...)` server (supervisor + subagents + a super-line WS transport) first.
- **Bun** (the TUI uses `@opentui`, which needs Bun's FFI). `pnpm -F @super-harness/tui start` runs `bun src/index.tsx`.
- Auth is a plain `--user <id>` (the super-harness default `authenticate`); no scene/mode/API keys.

## Quick start (the agent pattern)
Headless quits on stdin EOF, so `echo "/send …" | tui` sends then dies before the async turn lands. Use **`--control <fifo>`**: the harness re-opens the FIFO after each writer, so the session is long-lived and you inject commands with plain `echo`. Only `/quit` exits.

```bash
cd packages/tui
rm -f /tmp/h.in
pnpm -F @super-harness/tui start -- --headless --control /tmp/h.in \
  --url ws://localhost:4111/super-line --thread dbg-1 > /tmp/h.out 2>&1 &   # background; mkfifos /tmp/h.in
# wait for <<CONTROL …>> in /tmp/h.out, then:
echo "/send list three cities and their weather" > /tmp/h.in
# watch /tmp/h.out until <<TURN_DONE …>> or <<SUSPENDED …>>, then:
echo "/quit" > /tmp/h.in
```

## Markers (greppable, on their own line)
`<<SPILL dir=…>>` `<<READY>>` `<<CONTROL fifo=…>>` `<<TURN_START runId=…>>` `<<SUSPENDED tool=… request=… schema=…>>` `<<TURN_DONE tools=N errors=M tokens=K>>` `<<ERROR …>>` `<<DISCONNECTED>>`/`<<RECONNECTED>>` `<<INFO …>>`. Gate on these — don't sleep blindly.

## Commands (one per stdin line)
`/send <text>` start a turn · `/reply <text>` answer a pending ask_user (bare answer string; `yes`/`y` for an approval) · `/abort` abort the running turn · `/session` print thread/connection info · `/new [threadId]` fresh thread · `/quit`.

## Reading the transcript
Event lines: `node> <agent>: <task>` / `node< <agent> <reason> <tok> <ms>` frame each agent; `  tool> <name> <args>` / `  tool< <name> ok|ERROR <result>`; `  think:` / `  text:` / `  ERR:` / `  todo:`. Indentation = subagent depth. Tool errors appear inline with the message.

**Spill, not truncate.** Payloads >1200 chars and all images spill to the spill dir (`<<SPILL dir=…>>`, default `/tmp/super-harness-<pid>`) and show as `… → /tmp/…/<seq>-<tool>.txt`. `--full` inlines non-image content; image base64 is decoded to a viewable `.png`.

## Patterns & gotchas
- **`--json`** emits one raw `HarnessEvent` (derived from Store diffs) per line — pipe to `jq`.
- The tree comes from the **Store**, so a reconnect re-syncs current state automatically; text/reasoning stream as the node's fields grow (the headless coalesces them into one `text:`/`think:` block per node).
- One live turn per thread; `/send` while one is running is rejected — wait for `<<TURN_DONE>>`. Use `/abort` to stop a stuck turn.
- `--url`/`--user`/`--thread`/`--json`/`--full`/`--verbose`/`--control`/`--spill-dir` are the flags (see `src/config.ts`).
