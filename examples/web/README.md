# web example

The fullstack showcase: a super-harness backend on Hono and a React frontend
(Vite + Tailwind + shadcn/ui + ai-elements) that renders the live agent tree —
streaming text and reasoning, recursive subagent activity, tool-approval
dialogs, ask_user replies, modes, and threads.

```
examples/web/
├── server/   @super-harness/web-server — createHarness + serve() on a Hono http server
└── client/   @super-harness/web-client — Vite React app over @super-harness/react (headless client) + shadcn/ai-elements UI
```

## Run

```bash
pnpm -F @super-harness/web-server dev    # ws://localhost:4111/super-line (needs AI_GATEWAY_API_KEY in root .env)
pnpm -F @super-harness/web-client dev    # http://localhost:5173
```

Build the client (`pnpm -F @super-harness/web-client build`) and the server
serves it statically — one process at http://localhost:4111. The dist check
runs at boot, so restart the server after the first build.

## Inspector (super-line Control Center)

The server runs with the super-line inspector enabled (read-only wire
telemetry: connections, requests, room broadcasts, Store writes). Watch it
live:

```bash
pnpm -F @super-harness/web-server inspect   # opens the Control Center against ws://localhost:4111/super-line
```

The inspector channel is **unauthenticated** — it's on here because this is a
localhost dev example. Disable with `SUPER_HARNESS_INSPECTOR=0`, and never
ship `inspector: true` on an internet-facing node.

## What to try

- **Delegation**: ask a weather question — the supervisor delegates to the
  worker; its stream renders nested inside the supervisor's turn.
- **Approval**: "send me a report of this by email" — `send_report` is gated
  (`permissions: { tools: { send_report: 'ask' } }`), a dialog asks you to
  approve/decline/always-allow.
- **Suspension**: the supervisor may `ask_user` — the composer switches to
  reply mode.
- **Refresh mid-turn**: the tree rides a durable sqlite Store; a reload
  rebuilds the full transcript, user messages included.
- **Modes / threads**: switch chat ↔ terse in the header; threads persist in
  the sidebar (LibSQL-backed Mastra memory).
