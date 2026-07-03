# @super-harness/mastra-playground

A standalone Mastra scratchpad — **not wired to the harness**. Kept for
experimenting with raw Mastra APIs (agents, memory, storage, pubsub) without
super-harness in the loop; it predates the harness split and was relocated out
of `@super-harness/core`.

Contents: a `chatAgent` + `workerAgent` (`src/agents/`), a weather and an
ask-user tool (`src/tools/`), LibSQL storage (`src/storage.ts`), and
`makeMastra()` in `src/index.ts` assembling a `Mastra` instance with a caching
pubsub and Pino logger.

There is no start script — import `makeMastra()` from a Bun/Node REPL or a
scratch file. Needs `AI_GATEWAY_API_KEY` in the environment for the gateway
models.
