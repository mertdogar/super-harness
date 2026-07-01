// Entry: parse config, then pick a shell. TUI when stdout is a TTY (and --headless
// is absent); plain stdin/stdout otherwise. The dynamic import keeps OpenTUI + its
// native binaries out of the headless path entirely.

import { parseConfig } from "./config"

const config = parseConfig(process.argv.slice(2))

if (config.headless) {
  const { runHeadless } = await import("./headless")
  await runHeadless(config)
} else {
  const { runTui } = await import("./tui")
  await runTui(config)
}
