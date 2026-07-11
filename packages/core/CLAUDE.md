# @super-harness/core

`pnpm -F @super-harness/core test` — vitest, all fakes, no network. Tests
drive `run-node` through the `AgentRunner` seam with fake streams.

## Module map

- `harness.ts` — the runtime: bus, queue/steer, suspension registry, approval
  gates, modes, `HarnessThreads`, the per-turn `requestContext` host hook. The
  `#drive` loop runs a node, and on an approval suspension awaits the gate,
  then continues via `resolveToolCall` → new stream → same node.
- `run-node.ts` — one node's model turn: fullStream → chunk-adapter →
  enveloped events; returns `{ text, usage, approval? }`.
- `chunk-adapter.ts` — Mastra chunk → event body mapper; suppresses parent
  `tool_*` chunks for `delegate` calls (the child node stands in).
- `projector.ts` / `sink.ts` — fold events into the tree; `TreeSink` is the
  persistence port (memory impl here, super-line impl in server).
- `tools.ts` / `runtime.ts` — built-ins (`delegate`, `ask_user`, `todo`)
  injected per-call via `toolsets`; `delegate`/`todo` read `HarnessRuntime`
  off requestContext, `ask_user` suspends via `ctx.agent`.

## Gotchas (hard-won)

- **Always pass `runId: node.nodeId`** to `agent.stream` — approval resume
  (`approveToolCall`/`declineToolCall`) needs it or Mastra fails with
  `AGENT_RESUME_NO_SNAPSHOT_FOUND` after a 2s poll.
- A `tool-call-approval` chunk **suspends the run and closes the stream**.
  Continuation comes from `approveToolCall`/`declineToolCall`, which return
  new `MastraModelOutput` streams — hence the `#drive` loop, never an inline
  await inside the stream.
- Arm the approval gate **before** dispatching `approval_required` — a
  synchronous listener may respond immediately.
- Approval gating and mode overlays are **root-node only** (AgentController
  parity); subagents never gate. Built-ins (`todo`/`ask_user`/`delegate`)
  never gate. Per-tool `deny` beats yolo; final fallback is `ask`.
- `resume()` validates synchronously **before** consuming the parked
  suspension — a rejected resume must not destroy it.
- `abort()` resolves pending gates as aborted, clears suspensions AND the
  follow-up queue (emits `follow_up_queued 0`).
- Mode `availableTools` (→ internal `activeTools`) is unioned with the
  built-ins — a mode can't lock out `delegate`/`ask_user`/`todo`.
- `delegatesTo` is enforced only in `#spawnChild` (registry membership +
  allowed-edge check → isError result); the delegate tool's schema is a plain
  `z.string()` with the allowed list in the description. `maxDepth` defaults
  to 3; `createHarness` throws on unregistered ids at construction.
- **`requestContext` hook contract**: resolved ONCE per turn — resumes
  included (the host rebuilds per-turn state, never replays it) — with
  `{threadId, resource, mode}`; the mode's `metadata` is where host config
  like model tiers rides. The value lands on `RunOptions.requestContext` for
  EVERY node of the turn (root via `#drive`, children via
  `ThreadState.turnContext` in `#spawnChild`). The Mastra runner copies its
  `entries()` into a fresh per-node `RequestContext` beneath
  `HARNESS_RUNTIME_KEY` — the runtime key differs per node, so nodes must
  never share one instance; hooks should return a fresh context each call.
  Approval CONTINUATIONS rebuild it too: `resolveToolCall` carries
  `requestContext`+`runtime` because Mastra resumes with the options given to
  `approveToolCall`, not the original stream's — omit them and the
  post-approval remainder runs on an empty context (default models, no host
  entries). A hook throw settles the turn as an errored node in the tree
  (visible on the wire — sendMessage is fire-and-forget there) and rethrows,
  without wedging the thread.
- **Turn-lifecycle recipe for hosts** (per-turn renderers, MCP toolsets,
  teardown): before-turn work belongs IN the `requestContext` hook — it runs
  before the first stream opens, so anything it acquires (a renderer, a
  per-turn MCP client) is registered before any tool can need it. After-turn
  work rides `engine.subscribe`: a depth-0 `node_end` (any reason) is the
  root-turn boundary — dispose/snapshot there, keyed by threadId. Don't tie
  teardown to client disconnect; turns are server-owned and outlive sockets.
- `sendMessage`/`steer` take `files` (`{url, mimeType?}` attachments): image/*
  (or no mimeType) folds into the user message as an image content part,
  anything else as a file part (`mediaType` on the SDK side). Queued
  follow-ups carry theirs along.
- `@mastra/core` is a **peer** dep — never add it to `dependencies`.
