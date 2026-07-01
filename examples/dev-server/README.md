# @super-harness/dev-server

A runnable super-harness server for local testing and iterative development — a
supervisor that delegates to a `worker` subagent (live weather tool), wired
through `createHarness` and served over a super-line WebSocket. The `tui` client
(interactive or headless) connects to it.

## Run

```bash
# 1. put your gateway key in the repo-root .env
echo 'AI_GATEWAY_API_KEY=…' > ../../.env        # optional: CHAT_MODEL=anthropic/claude-haiku-4.5

# 2. start the server (Bun)
pnpm -F @super-harness/dev-server start          # ws://localhost:4111/super-line

# 3. drive it with the tui (another terminal)
pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line          # cockpit
pnpm -F @super-harness/tui start -- --headless --url ws://localhost:4111/super-line   # agents
```

`SUPER_HARNESS_PORT` overrides the port; `CHAT_MODEL` the gateway model.
