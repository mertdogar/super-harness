// App-level glue: builds the harness client for a chosen node. No URL params —
// the node is picked in the header selectbox and the thread lives in client
// state (resume past ones from the sidebar). VITE_NODE_BASE_PORT (set only by
// the docker frontend) turns on multi-node: node N → ws://<host>:<base+N>/super-line.
// Without it (local `pnpm dev`), one node on VITE_SUPER_HARNESS_URL ?? :4111.
import { createHarnessClient, type HarnessClient } from "@super-harness/react"
import { nanoid } from "nanoid"

const BASE_PORT = Number(import.meta.env.VITE_NODE_BASE_PORT) || 0
export const MULTINODE = BASE_PORT > 0
export const NODES = MULTINODE
  ? Array.from({ length: Number(import.meta.env.VITE_NODE_COUNT) || 3 }, (_, i) => i + 1)
  : [1]
export const DEFAULT_NODE = 1

function nodeUrl(node: number): string {
  if (MULTINODE) return `ws://${location.hostname}:${BASE_PORT + node}/super-line`
  return import.meta.env.VITE_SUPER_HARNESS_URL ?? "ws://localhost:4111/super-line"
}

export const freshThreadId = (): string => nanoid()

// One stable resourceId groups all tabs: it scopes the thread sidebar and — since
// it's also the store principal — lets a tab on any node read a thread another
// node wrote (a grant on node-1 satisfies a read on node-2).
export function createClientForNode(node: number, threadId: string): HarnessClient {
  return createHarnessClient({ url: nodeUrl(node), params: { resourceId: "web" }, threadId })
}
