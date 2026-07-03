# @super-harness/core

The transport-free harness session runtime. `createHarness` hosts a tree of
[Mastra](https://mastra.ai) Agents — one supervisor delegating to subagents via
`delegatesTo` edges — and consolidates everything a hosting surface needs:

- **Event bus** — `harness.subscribe((threadId, event) => …)` delivers every
  raw node event (full-fidelity streaming at every delegation depth) plus
  synthetic session events (`tree_changed`, `suspended`, `approval_required`,
  `mode_changed`, `follow_up_queued`, thread CRUD).
- **Follow-up queue + steer** — `sendMessage` during a running turn queues (or
  interrupts, with `steer`).
- **Suspensions** — `ask_user` parks the turn; `resume({ threadId, toolCallId,
  resumeData })` continues it.
- **Tool approvals** — permission rules (`allow | ask | deny` per tool or
  category, session grants, yolo) gate supervisor tool calls through Mastra's
  approval suspension; `respondToApproval` drives the continuation.
- **Modes** — per-thread instruction overlays + `availableTools` allowlists,
  persisted in thread metadata.
- **Threads** — `harness.threads` (list/create/rename/delete) over any
  structural `ThreadStore`; a Mastra `Memory` instance fits directly.

No super-line here. The WebSocket binding is `@super-harness/server`; the wire
types live in `@super-harness/shared`.

## Install

```bash
pnpm add @super-harness/core @mastra/core
```

`@mastra/core` is a peer dependency — you bring your own Agents.

## Use

```ts
import { Agent } from '@mastra/core/agent'
import { createHarness } from '@super-harness/core'

const harness = createHarness({
  supervisor: new Agent({ id: 'supervisor', /* model, instructions, memory */ }),
  subagents: [{ agent: workerAgent }],          // delegatesTo defaults: supervisor → all
  memory,                                        // optional: threads + mode persistence
  modes: [{ id: 'chat', name: 'Chat', instructions: '…', metadata: { default: true } }],
  permissions: { tools: { dangerous_tool: 'ask' } },
})

const unsubscribe = harness.subscribe((threadId, e) => { /* fold, render, relay */ })
await harness.sendMessage({ threadId: 't1', content: 'hello' })
```

The supervisor gets injected built-in tools per call: `delegate` (spawns a
child node), `ask_user` (suspends, root only), `todo` (streams a task list).
Approval gating and mode overlays apply to the **root node only** — subagents
run headless.

See the repository root README for the full architecture and event vocabulary.
