# mastra-playground

Standalone Mastra scratchpad — **not part of the harness**. Nothing here is
imported by `packages/*`; don't route harness features through it, and don't
"fix" it to match harness patterns. It exists to reproduce/verify raw Mastra
behavior (agents, tools, memory, pubsub) in isolation, which is useful when
debugging whether a problem is ours or Mastra's.

No start script, no tests. `makeMastra()` in `src/index.ts` is the entry.
Keep its `@mastra/core` version in lockstep with the rest of the repo.
