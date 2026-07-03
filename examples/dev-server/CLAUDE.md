# dev-server example

`pnpm -F @super-harness/dev-server start` — Bun, loads the **repo-root**
`.env` (`--env-file=../../.env`). Exits code 2 if `AI_GATEWAY_API_KEY` is
missing. `SUPER_HARNESS_PORT` (default 4111) and `CHAT_MODEL` (default
`anthropic/claude-haiku-4.5`) override.

- Topology: `supervisor` (no tools of its own) delegates to `worker`, which
  has a live open-meteo weather tool. The supervisor's instructions force
  delegation — good for exercising the delegate/tree path.
- Store backend is `{ type: "memory" }` — the super-line tree is NOT durable
  across restarts. Mastra memory IS durable (LibSQL `dev.db`,
  `lastMessages: 10`), which is what makes `--thread <id>` resume work.
- Two modes registered: `chat` (default) and `terse` — try `/mode terse`.
- The supervisor has no gated tool, so the approval flow (`/approve`) can't be
  exercised here without adding a tool + `permissions: { tools: { … : 'ask' } }`
  to the harness config.
- `dev.db*` is gitignored; delete it to reset conversation memory.
