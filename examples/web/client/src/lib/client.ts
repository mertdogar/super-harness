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

// resourceId groups all of this "user's" tabs: the server scopes the thread
// list to it and joins every tab to its resource room, so create/rename/delete
// propagate across tabs. One stable value here → all tabs share one sidebar.
export const harnessClient = createHarnessClient({
  url: import.meta.env.VITE_SUPER_HARNESS_URL ?? "ws://localhost:4111/super-line",
  params: { resourceId: "web" },
  threadId: initialThreadId(),
})
