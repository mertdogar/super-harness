# @super-harness/tui

**Bun only** — `pnpm -F @super-harness/tui start`, typecheck with
`pnpm -F @super-harness/tui typecheck`. No tests here; the session logic is
exercised end to end via the dev-server.

## Map

- `session.ts` — connection + state: joins the thread, opens Stores via
  `subscribeTree`, tracks turns/pending ask_user/pending approval, exposes
  `resumeCommand()`.
- `dispatch.ts` — slash-command parser shared by both shells.
- `tui.tsx` / `headless.ts` — the OpenTUI cockpit vs the marker-protocol
  shell. `index.tsx` picks by `--headless` / `!stdout.isTTY`.

## Gotchas

- **Never truncate the thread id in the UI.** The header once showed
  `id.slice(0, 8)` and users "resumed" with a prefix nanoid that silently
  created a fresh thread. Thread ids are 21-char nanoids; show them whole.
- Both shells print a resume command on exit; the cockpit registers it on
  `process.on("exit")` **after** `createCliRenderer` so it survives the
  alt-screen restore.
- Turn tracking keys off ANY root `node_start`/`node_end` (not just locally
  sent messages) — server-drained follow-ups and steer must still render as
  turns.
- Don't block `/send` while a turn is running — the server queues follow-ups;
  a client-side guard makes the queue unreachable.
- `session.approve()` clears the pending approval only when the server
  responds `ok: true`.
