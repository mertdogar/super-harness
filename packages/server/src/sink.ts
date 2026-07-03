// The durable TreeSink: writes the projector's folded tree into super-line
// Stores. Typed against a structural subset of super-line's ServerStoreHandle
// so it stays fakeable and dodges the multi-`core` type skew.
//
// Writes go through the handle's `write(id, data)` (a whole-doc LWW `apply()`),
// NOT the co-writer `open()` — self-clustering stores (store-pglite) have no
// `open()`, and a whole-doc sink never needs the replica's getSnapshot/merge.
// Stream events fire fast (one per token); persisting each would hammer a
// central store, so writes are COALESCED per resource on a trailing debounce —
// the first event creates the Resource, later events flush the latest doc at
// most once per `flushMs`. Clients render from the store snapshot + onChange;
// a reload reads the store. (Cadence is app policy — see the store-pglite
// handoff §1.)

import type { TreeSink, ThreadDoc } from '@super-harness/core'

interface StoreNs {
  create?(id: string, data: unknown, accessRules?: unknown): Promise<void>
  read?(id: string): Promise<{ data?: unknown } | undefined>
  write(id: string, data: unknown): Promise<void>
}

const DEFAULT_FLUSH_MS = 150

// `nodeStore`/`threadStore` are `srv.store('node')` / `srv.store('thread')`.
// grantTo() = principals allowed to READ, evaluated at each Resource creation
// (so users who joined after the sink was built still get onto NEW Resources;
// already-created ones are granted by the join handler). Stores are
// deny-by-default. One thread Resource id = threadId; node Resource id = nodeId.
export function superlineTreeSink(opts: {
  nodeStore: StoreNs
  threadStore: StoreNs
  threadId: string
  grantTo: () => string[]
  flushMs?: number
}): TreeSink {
  const { nodeStore, threadStore, threadId, grantTo } = opts
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS
  const rules = () => Object.fromEntries(grantTo().map((p) => [p, { read: true }]))

  // The persisted doc that predates this process (server restart on a durable
  // backend). Folds start from an empty tree, so writes must merge onto this
  // base or the first new turn clobbers the thread's history.
  let threadBase: ThreadDoc | undefined
  const mergeThread = (doc: ThreadDoc): ThreadDoc => {
    if (!threadBase) return doc
    return {
      turns: [...threadBase.turns.filter((t) => !doc.turns.includes(t)), ...doc.turns],
      todos: doc.todos ?? threadBase.todos,
      nodes: { ...threadBase.nodes, ...doc.nodes },
    }
  }

  // One coalescing writer per resource: create once (with its read grant), then
  // trailing-debounce whole-doc writes so a fast stream lands ≤1 write/flushMs
  // and the final doc always persists. Create the Resource WITH its grant and
  // AWAIT it before writing — a fire-and-forget create races the write (apply()
  // to a missing row throws) and would leave the client's read denied.
  const makeWriter = (
    ns: StoreNs,
    id: string,
    transform: (doc: ThreadDoc) => unknown,
    prepare?: (doc: ThreadDoc) => Promise<void>,
  ): ((doc: ThreadDoc) => void) => {
    let latest: ThreadDoc
    let ensured: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    let dirty = false

    const flush = (): void => {
      dirty = false
      void ensured!
        .then(() => ns.write(id, transform(latest)))
        .catch((e) => console.error('[sink] write failed', e))
    }

    return (doc) => {
      latest = doc
      if (!ensured) {
        // First event: prepare (thread base read) then create the initial doc.
        ensured = (async () => {
          await prepare?.(doc)
          // Swallow only the benign "already exists" (restart, or the thread doc
          // pre-created by the join handler). A genuine create failure must
          // surface — otherwise every later write (apply(), which needs the row)
          // throws a misleading NOT_FOUND forever and the doc never persists.
          await ns.create?.(id, transform(latest), rules()).catch((e) => {
            if ((e as { code?: string })?.code !== 'CONFLICT') console.error('[sink] create failed', id, e)
          })
        })()
        return
      }
      dirty = true
      if (!timer) {
        timer = setTimeout(() => {
          timer = null
          if (dirty) flush()
        }, flushMs)
      }
    }
  }

  const nodeWriters = new Map<string, (doc: ThreadDoc) => void>()

  const writeThread = makeWriter(threadStore, threadId, mergeThread, async () => {
    const existing = await threadStore.read?.(threadId).catch(() => undefined)
    const data = existing?.data as ThreadDoc | undefined
    if (data && Array.isArray(data.turns) && data.turns.length > 0) threadBase = data
  })

  return {
    writeNode: (node) => {
      let write = nodeWriters.get(node.nodeId)
      if (!write) {
        write = makeWriter(nodeStore, node.nodeId, (d) => d)
        nodeWriters.set(node.nodeId, write)
      }
      write(node as unknown as ThreadDoc)
    },
    writeThread,
  }
}
