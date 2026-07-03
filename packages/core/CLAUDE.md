# @super-harness/core

`pnpm -F @super-harness/core test` — vitest, all fakes, no network. Tests
drive `run-node` through the `AgentRunner` seam with fake streams.

## Module map

- `harness.ts` — the runtime: bus, queue/steer, suspension registry, approval
  gates, modes, `HarnessThreads`. The `#drive` loop runs a node, and on an
  approval suspension awaits the gate, then continues via
  `resolveToolCall` → new stream → same node.
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
- Mode `activeTools` is unioned with the built-ins — a mode can't lock out
  `delegate`/`ask_user`/`todo`.
- `delegatesTo` is enforced only in `#spawnChild` (registry membership +
  allowed-edge check → isError result); the delegate tool's schema is a plain
  `z.string()` with the allowed list in the description. `maxDepth` defaults
  to 3; `createHarness` throws on unregistered ids at construction.
- `@mastra/core` is a **peer** dep — never add it to `dependencies`.
