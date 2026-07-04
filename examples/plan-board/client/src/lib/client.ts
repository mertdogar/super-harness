// Builds the harness client in owned/url mode. A fresh thread id per page load,
// so a refresh starts a new plan. No `stores` needed in url mode — the client
// supplies the in-memory harness.node/harness.thread replicas itself.
import { createHarnessClient, type HarnessClient } from "@super-harness/react"
import { nanoid } from "nanoid"

const URL = import.meta.env.VITE_PLAN_BOARD_URL ?? "ws://localhost:4113/super-line"

export function createPlanBoardClient(): HarnessClient {
  return createHarnessClient({ url: URL, threadId: nanoid() })
}
