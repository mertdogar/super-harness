// Parse argv into the harness runtime config. The client authenticates with a
// plain userId (the super-harness default authenticate) — no scene/mode/creds
// like the omma harness; this drives any super-harness server via --url.

import { nanoid } from "nanoid"

export interface HarnessConfig {
  url: string
  params: Record<string, string>
  threadId: string
  headless: boolean
  json: boolean
  verbose: boolean
  full: boolean
  control?: string
  spillDir: string
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

function option(argv: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = argv.indexOf(name)
    if (i !== -1 && i + 1 < argv.length) return argv[i + 1]
  }
  return undefined
}

export function parseConfig(argv: string[]): HarnessConfig {
  const url = option(argv, "--url") ?? process.env.SUPER_HARNESS_URL ?? "ws://localhost:4111/super-line"
  const params: Record<string, string> = { userId: option(argv, "--user") ?? "local" }

  return {
    url,
    params,
    threadId: option(argv, "--thread") ?? nanoid(),
    headless: hasFlag(argv, "--headless") || !process.stdout.isTTY,
    json: hasFlag(argv, "--json"),
    verbose: hasFlag(argv, "--verbose"),
    full: hasFlag(argv, "--full"),
    control: option(argv, "--control"),
    spillDir: option(argv, "--spill-dir") ?? `/tmp/super-harness-${process.pid}`,
  }
}
