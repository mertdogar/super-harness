---
title: Run the terminal client
---

# Run the terminal client

The Bun-based terminal client has an interactive cockpit and a line-oriented
headless mode for scripts and other agents.

```bash
pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line
pnpm -F @super-harness/tui start -- --headless --url ws://localhost:4111/super-line
```

Use `/send`, `/reply`, `/approve`, `/deny`, `/mode`, `/threads`, and `/abort`
to drive the session. Headless mode uses a marker protocol on standard output.
