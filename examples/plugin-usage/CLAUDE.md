# plugin-usage example

The getting-started **showcase**: the smallest end-to-end proof that a host adds
the harness with one `plugins: [harness(engine)]` line + `harnessContract()` in
its contract. Point new integrators here first.

`pnpm -F @super-harness/plugin-usage start` (server, Bun, root `.env` with
`AI_GATEWAY_API_KEY`), then `pnpm -F @super-harness/plugin-usage client` in a
second terminal. `PLUGIN_USAGE_PORT` (4115) / `CHAT_MODEL` override; the client
takes an optional prompt as argv.

- **Distinct from `composed-host`**: same plugin mechanism, but this is the
  narrated didactic version with a self-contained streaming terminal client and
  a README written as the adoption pitch. composed-host is the terse composition
  reference; auth adds `@super-line/plugin-auth`.
- **Topology**: `supervisor` delegates to a `researcher` subagent that owns a
  LOCAL `lookup_population` tool (no network) — one turn exercises delegation +
  tool + streaming deterministically. No Mastra memory (the client never calls
  `listThreads`), so `memoryCollections()` is enough.
- **The client renders via `diffTree()`** from `@super-harness/shared`: it keeps
  the previous `ClientTree`, diffs each snapshot into the shared `HarnessEvent`
  stream, and prints events indented by `depth`. It's the reference for "any
  consumer reads a session the same way" — don't replace it with a bespoke
  snapshot walker.
- The harness client is **borrowed** (`createHarnessClient({ client })`): its
  `close()` detaches listeners; `line.close()` closes the socket.
