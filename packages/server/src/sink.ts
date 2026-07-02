// The durable TreeSink: writes the projector's folded tree into super-line
// Stores. Typed against a structural subset of super-line's ServerStoreHandle
// so it stays fakeable and dodges the multi-`core` type skew.

import type { TreeSink } from '@super-harness/core'

interface StoreReplica {
  set(data: unknown): void
}
interface StoreNs {
  create?(id: string, data: unknown, accessRules?: unknown): Promise<void>
  open(id: string, opts?: { origin?: string }): StoreReplica
}

// `nodeStore`/`threadStore` are `srv.store('node')` / `srv.store('thread')`.
// grantTo = principals allowed to READ (the joined connections); Stores are
// deny-by-default. One thread Resource id = threadId; node Resource id = nodeId.
export function superlineTreeSink(opts: {
  nodeStore: StoreNs
  threadStore: StoreNs
  threadId: string
  grantTo: string[]
}): TreeSink {
  const { nodeStore, threadStore, threadId, grantTo } = opts
  const rules = Object.fromEntries(grantTo.map((p) => [p, { read: true }]))
  const nodeReplicas = new Map<string, StoreReplica>()
  const nodePending = new Map<string, Promise<StoreReplica>>()
  let threadReplica: StoreReplica | undefined
  let threadPending: Promise<StoreReplica> | undefined

  // Create the Resource WITH its read grant and AWAIT it before opening — the
  // co-writer's open() auto-creates deny-by-default, so a fire-and-forget create
  // races and the client's read is denied (silently: read denials don't surface
  // as write errors). First write per Resource pays one create round-trip; the
  // rest set synchronously on the cached replica.
  const ensure = async (ns: StoreNs, id: string, initial: unknown): Promise<StoreReplica> => {
    await ns.create?.(id, initial, rules).catch(() => {})
    return ns.open(id, { origin: 'harness' })
  }

  return {
    writeNode: (node) => {
      const cached = nodeReplicas.get(node.nodeId)
      if (cached) {
        cached.set(node)
        return
      }
      let pending = nodePending.get(node.nodeId)
      if (!pending) {
        pending = ensure(nodeStore, node.nodeId, node)
        nodePending.set(node.nodeId, pending)
      }
      void pending.then((r) => {
        nodeReplicas.set(node.nodeId, r)
        r.set(node)
      })
    },
    writeThread: (doc) => {
      if (threadReplica) {
        threadReplica.set(doc)
        return
      }
      if (!threadPending) threadPending = ensure(threadStore, threadId, doc)
      void threadPending.then((r) => {
        threadReplica = r
        r.set(doc)
      })
    },
  }
}
