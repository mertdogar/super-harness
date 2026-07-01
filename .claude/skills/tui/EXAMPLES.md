# tui — recipes

All commands run from `packages/tui/`. `pnpm -F @super-harness/tui start -- <flags>` works from anywhere and is equivalent to `bun src/index.tsx <flags>`. Every recipe assumes a super-harness server is up at `--url` (default `ws://localhost:4111/super-line`).

## 1. One full turn, then exit (self-contained driver)

Launch in the background with a control FIFO, drive it, capture the transcript. Gate on markers — never sleep blindly.

```bash
FIFO=/tmp/h.in; OUT=/tmp/h.out
rm -f "$FIFO"; cd packages/tui
pnpm -F @super-harness/tui start -- --headless --control "$FIFO" \
  --url ws://localhost:4111/super-line --thread dbg-1 > "$OUT" 2>&1 &

# wait for the control channel, then send one message
for i in $(seq 1 100); do grep -q '<<CONTROL' "$OUT" && break; sleep 0.3; done
echo "/send research three cities and summarize" > "$FIFO"

# wait for the turn to settle (done OR a question OR an error)
for i in $(seq 1 400); do grep -qE '<<TURN_DONE|<<SUSPENDED|<<ERROR' "$OUT" && break; sleep 0.5; done
echo "/quit" > "$FIFO"
cat "$OUT"
```

Why the FIFO: headless reads stdin and **quits on EOF**, so `echo "/send …" | tui` sends then dies before the async turn lands. `--control` re-opens the FIFO after every writer, so the session outlives each `echo` and only `/quit` exits. A writer's `echo > fifo` blocks until the harness re-opens, so commands across the reopen gap are never lost.

## 2. Answer an ask_user (suspend → resume)

If the supervisor calls `ask_user`, the turn suspends. Reply with a **bare answer string** (an option label or free text). Approvals: `yes`/`y`.

```bash
# after <<SUSPENDED tool=ask_user request={"question":…}…>>
echo "/reply use a dark theme" > "$FIFO"
# turn resumes on the same thread/tree; wait again for <<TURN_DONE>> or the next <<SUSPENDED>>
```

The `<<SUSPENDED …>>` marker carries the full `request` (question + any options) and the resume `schema`.

## 3. Abort a stuck or unwanted turn

```bash
echo "/abort" > "$FIFO"     # aborts the running turn; nodes settle as 'aborted'
```

## 4. Read the full content of a spilled payload

Big results and images spill to the spill dir (`<<SPILL dir=…>>`, default `/tmp/super-harness-<pid>`), shown inline as `… → /tmp/…/<seq>-<tool>.txt`.

```bash
grep '<<SPILL' "$OUT"                     # find the dir
ls -la /tmp/super-harness-*/              # the full payloads
cat /tmp/super-harness-*/12-execute.txt   # full tool result
file /tmp/super-harness-*/*.png           # decoded images
```

## 5. Raw events for machine parsing

`--json` emits one `HarnessEvent` per line (derived from Store diffs; no spill, no formatting):

```bash
pnpm -F @super-harness/tui start -- --headless --control "$FIFO" --json \
  --url ws://localhost:4111/super-line --thread j1 &
# …drive as usual…
grep '"type":"tool_end"' "$OUT" | jq -r 'select(.isError) | .toolCallId'   # failing tools
jq -rc 'select(.type=="error") | .message' "$OUT"                          # error messages
```

## 6. Interactive multi-turn session

The FIFO session stays alive between turns — send, read, send again, all on one process/thread:

```bash
echo "/send draft an outline" > "$FIFO"    # turn 1
# …wait for <<TURN_DONE>>…
echo "/session" > "$FIFO"                    # thread / connection info
echo "/send now expand section 2" > "$FIFO" # turn 2 (same thread, history persists server-side)
echo "/quit"    > "$FIFO"
```

## 7. Interactive cockpit (humans)

Drop `--headless` (and run in a real TTY) for the OpenTUI cockpit — type-and-Enter sends, `/`-lines are commands, a docked `<select>` handles `ask_user`:

```bash
pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line --thread ui-1
```

## Troubleshooting
- **`<<ERROR …>>` right after connect** → no server at `--url`, or wrong path. Start your `createHarness(...)` server and check the WS URL.
- **Turn hangs after `/send`** → it likely suspended on `ask_user`; grep `<<SUSPENDED`. Reply or `/abort`.
- **`turn in flight — wait`** → one live turn per thread; wait for `<<TURN_DONE>>` before the next `/send`.
- **Nothing renders but no error** → confirm the server writes the `node`/`thread` Stores (the tui reads those); check the server exposes them on the same super-line server the WS transport serves.
