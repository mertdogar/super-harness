---
title: Plugin architecture
---

# Plugin architecture

The plugin model has a contract-time half and a runtime half. Together they
make the harness a small addition to a host instead of a parallel system.

- `harnessContract()` declares the harness surface and collections.
- `harness(engine)` supplies RLS policies, handlers, and the event-to-storage bridge.
- `createHarnessClient()` reads the resulting tree through the host's client.

All three use `@super-harness/shared` as the wire ABI, so server and client
must deploy compatible versions.
