# @super-harness/plan-board

A focused showcase of the harness's **todo/task** feature: give a planner a
goal and watch it draft a live task list and work through it, with the plan
statuses flipping `pending → in progress → completed` in real time. Along the
way it also exercises **ask_user** (a clarifying question), **delegation** (a
`researcher` subagent), live **streaming**, and a **HITL approval gate** (a
fake `publish_plan` tool) — the whole plan-and-execute loop on one screen.

It's built on the same stack as the [web example](../web/README.md) — tailwind,
shadcn `ui/`, and `ai-elements/` on the headless `@super-harness/react` client,
reusing web's `NodeView` and `ApprovalDialog` verbatim. The difference is the
layout: where web is a full chat cockpit with a thread sidebar, this is a
single-screen, plan-first board — a goal composer, the live plan checklist, then
the execution stream — with no sidebar, threads, or modes UI.

## Run

You need `AI_GATEWAY_API_KEY` in the repo-root `.env`. Start the server and the
client in separate terminals:

```bash
pnpm -F @super-harness/plan-board-server dev     # ws://localhost:4113/super-line (tsx watch)
pnpm -F @super-harness/plan-board-client dev     # http://localhost:5173 (vite)
```

Open http://localhost:5173, keep or edit the seeded goal ("Plan a 3-day Rome
trip"), and press **Plan ▶**.

`SUPER_HARNESS_PORT` overrides the server port (default 4113); `CHAT_MODEL` the
gateway model (default `anthropic/claude-sonnet-4.5` — the scripted beats want a
strong instruction-follower). The client reads `VITE_PLAN_BOARD_URL` if you move
the server.

## What to watch

The planner runs a fixed sequence, so all four features surface in one turn:

1. **ask_user** — if the goal is missing a key detail, an inline card asks one
   clarifying question. Answer it to continue.
2. **Plan (todos)** — the planner calls the `todo` tool with a 4-6 item plan;
   the checklist renders it and updates the glyph as each item moves to
   in-progress (`◐`) and completed (`✓`).
3. **Delegation + streaming** — at least one research item is delegated to the
   `researcher` subagent, which appears as a nested node in the execution
   stream (with its `get-weather` tool call). Reasoning and text stream live.
4. **Approval gate** — when every item is done the planner calls
   `publish_plan`, which parks an approval card. Choose **Allow** or **Deny**.

Ask a follow-up ("make it four days") and the planner revises the same plan —
Mastra memory (`dev.db`) carries the conversation across turns.

## Notes

- **Todos are thread-level, not per-node.** The plan is one ambient list on the
  thread (`tree.todos`), separate from the delegation tree (`tree.nodes`). The
  board renders them as two regions on purpose — there is no wire link tying a
  specific todo line to a specific delegated node.
- The server uses an **in-memory tree Store** and mints a **fresh thread id per
  page load**, so a refresh starts a new plan. `dev.db` (Mastra memory, for
  cross-turn recall and `listThreads`) is gitignored; delete it to reset.
- The fake `publish_plan` tool exists only to exercise the approval flow. Don't
  make it real.
