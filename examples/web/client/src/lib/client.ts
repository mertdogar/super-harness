// App-level glue: one client instance, thread id from the URL (?thread=…) so a
// refresh resumes the same conversation. The state machine lives in
// @super-harness/react.
import { createHarnessClient } from "@super-harness/react"
import { nanoid } from "nanoid"

function initialThreadId(): string {
  const fromUrl = new URLSearchParams(location.search).get("thread")
  if (fromUrl) return fromUrl
  const id = nanoid()
  history.replaceState(null, "", `?thread=${id}`)
  return id
}

export const harnessClient = createHarnessClient({
  url: import.meta.env.VITE_SUPER_HARNESS_URL ?? "ws://localhost:4111/super-line",
  params: { userId: "web" },
  threadId: initialThreadId(),
})
