# @super-harness/tui

Terminal client for a super-harness server: an OpenTUI cockpit (interactive
alt-screen UI) and a headless stdin/stdout shell for driving agents from
scripts or other agents. **Requires Bun** (OpenTUI uses `bun:ffi`).

## Run

```bash
pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line            # cockpit
pnpm -F @super-harness/tui start -- --headless --url ws://localhost:4111/super-line # headless
```

Headless mode is also auto-selected when stdout is not a TTY. On exit, both
shells print the exact command to resume the session (`--thread <id>`).

## Flags

| Flag | Meaning |
| --- | --- |
| `--url <ws://…>` | server URL (or `SUPER_HARNESS_URL`; default `ws://localhost:4111/super-line`) |
| `--user <id>` | userId for the default authenticate (default `local`) |
| `--thread <id>` | resume an existing thread (default: fresh nanoid) |
| `--headless` | line-based shell with `<<MARKER>>` protocol |
| `--json` | JSON event output (headless) |
| `--verbose` / `--full` | more event detail / no truncation |
| `--control <fifo>` | FIFO path for out-of-band commands (headless) |
| `--spill-dir <dir>` | where large payloads are spilled to files |

## Commands

`/send`, `/reply`, `/approve [note]`, `/deny [note]`, `/always`, `/mode [id]`,
`/threads`, `/abort`, `/session`, `/new [threadId]`, `/help`, `/quit`.

The headless marker protocol (`<<TURN_START>>`, `<<SUSPENDED …>>`,
`<<APPROVAL_REQUIRED …>>`, `<<RESUME …>>`, …) is documented in the repository
root README under “Terminal client”.
