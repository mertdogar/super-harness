# plugin-usage — add a multi-agent harness to your super-line app in one line

This is the getting-started showcase. If you already run a
[super-line](https://github.com/mertdogar/super-line) server, **super-harness
drops in as a plugin** — a full multi-agent harness (supervisor + subagents,
live streaming, delegation, tool calls, HITL approvals, threads, modes) riding
your existing socket, contract, auth, and storage. No separate service, no
second connection.

```ts
// contract.ts — your contract, plus one fragment
export const app = defineContract({
  plugins: [harnessContract()],        // ← contributes the harness surface + collections
  shared: defineSurface({ /* your own requests */ }),
  roles: { user: {} },
})

// server.ts — your server, plus one plugin
const srv = createSuperLineServer(app, {
  transports,
  collections: memoryCollections(),    // one backend serves the harness + your own
  authenticate, identify,              // identify → the principal the harness RLS keys on
  plugins: [harness(engine)],          // ← harness.* is subtracted from implement()
})
srv.implement({ shared: { /* only YOUR handlers */ }, user: {} })
```

That's the whole integration. Everything else in this folder is a runnable proof.

## Run it

Needs `AI_GATEWAY_API_KEY` in the repo-root `.env` (see `.env.example`).

```bash
# terminal 1 — your server + the harness plugin
pnpm -F @super-harness/plugin-usage start

# terminal 2 — a self-contained streaming client (no browser, no UI framework)
pnpm -F @super-harness/plugin-usage client
```

`PLUGIN_USAGE_PORT` (default 4115) and `CHAT_MODEL` (default
`anthropic/claude-haiku-4.5`) override. Pass a prompt as args to the client:
`pnpm -F @super-harness/plugin-usage client "population of Tokyo?"`.

## What you'll see

The client calls your own `app.serverInfo` request first (proof both surfaces
share one socket), then sends a turn. The supervisor **delegates** to a
`researcher` subagent, which calls a local `lookup_population` **tool** — and the
whole multi-agent tree streams into your terminal:

```
[plugin-usage] app.serverInfo → My App (harness: true)
[plugin-usage] sending: What's the population of Istanbul? …

● supervisor
  ▸ researcher — Find the current population of Istanbul, Turkey.
  → lookup_population {"city":"Istanbul"}
  ✓ {"city":"Istanbul","population":15460000}
  Istanbul, Turkey has an approximate population of 15.46 million people.
  ✔ complete · 1,747 tokens
According to the researcher, Istanbul has an approximate population of
**15.46 million people**, one of the most populous cities in the world.
✔ complete · 2,228 tokens

[plugin-usage] turn complete — your surface + a full multi-agent harness on ONE socket. (3,975 tokens)
```

Each node's stream (and its tools) is indented one level below its header; the
`researcher` block is nested under the `supervisor` because it's a delegated
child. When the model emits chain-of-thought, it streams as a dim `💭` line.

The renderer (`src/client.ts`) is deliberately tiny: it feeds each tree snapshot
through `diffTree()` from `@super-harness/shared` — **the same fold a browser UI,
the TUI, or an eval uses** — and prints the resulting `HarnessEvent` stream. Any
consumer reads a session the same way.

## The four host obligations

1. **Merge the fragment** — `harnessContract()` in your contract's `plugins`. It
   contributes the harness surface (on `shared`) and the four `harness.*`
   collections (`threads`/`nodes`/`tools`/`membership`).
2. **One collections backend** — `collections: memoryCollections()` (or
   `sqliteCollections()` / `pgliteCollections()`). It serves the harness
   collections beside any of your own; the harness never owns a backend.
3. **`identify` → your principal** — the harness's row-level security keys on
   `ctx.userId`. Skip `identify` and every membership-gated read is denied (the
   principal falls back to a random connection id) → a silently empty tree.
4. **Add the plugin** — `harness(engine)` in `plugins`. Every `harness.*` handler
   key is subtracted from `implement()`, so you implement only your own requests.

## Where next

- **`examples/composed-host`** — the composition reference: a host with its own
  request surface beside the harness, one shared browser-style client.
- **`examples/auth`** — pair the harness with `@super-line/plugin-auth`: real
  sign-up / sign-in, identity → the collection principal, `identify` for free.
- **`examples/web` / `examples/plan-board`** — full React UIs on the
  shadcn/ai-elements stack (chat and todo/plan layouts).
- **`@super-harness/react`** — the headless `HarnessClient` + `useHarness` hooks
  this example's client is built on; **`@super-harness/tui`** — a terminal
  cockpit.
