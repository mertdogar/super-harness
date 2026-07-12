---
title: Choose durable storage
---

# Choose durable storage

Choose the collections backend through `serve()` or your
[super-line](https://super-line.dogar.biz) host. The harness stores structural
state as typed rows; token deltas remain ephemeral.

- Use `{ type: 'memory' }` for tests and disposable local runs.
- Use `{ type: 'sqlite', file: './harness.db' }` for the standalone default.
- Use `{ type: 'pglite', pgUrl, electricUrl? }` for multi-node deployments.

All modes preserve threads, nodes, tools, and membership rows. Clients rebuild
the current tree from those rows after reconnecting.
