---
title: Your first harness
---

# Your first harness

Create a supervisor with a worker, run the demo server, and inspect the live
session with the terminal client.

## Install dependencies

Install the workspace dependencies before running the included example.

```bash
pnpm install
cp .env.example .env
```

Set `AI_GATEWAY_API_KEY` in `.env`. The demo uses that key to run its Mastra
agents.

## Start the server and client

Run the server in one terminal, then connect the terminal client in another.

```bash
pnpm -F @super-harness/dev-server start
pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line
```

Ask about the weather in Istanbul. The supervisor delegates to a worker, and
the terminal renders both branches as they stream.

## Next steps

Add the harness to an existing super-line host in [Add the server plugin](./server-plugin).
