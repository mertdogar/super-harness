// The durable TreeSink: writes the projector's folded tree into super-line
// Stores. Typed against a structural subset of super-line's ServerStoreHandle
// so it stays fakeable and dodges the multi-`core` type skew.

import type { TreeSink, ThreadDoc } from '@super-harness/core'

interface StoreReplica {
  set(data: unknown): void
}
interface StoreNs {
  create?(id: string, data: unknown, accessRules?: unknown): Promise<void>
  read?(id: string): Promise<{ data?: unknown } | undefined>
  open(id: string, opts?: { origin?: string }): StoreReplica
}

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
}): TreeSink {
  const { nodeStore, threadStore, threadId, grantTo } = opts
  const rules = () => Object.fromEntries(grantTo().map((p) => [p, { read: true }]))
  const nodeReplicas = new Map<string, StoreReplica>()
  const nodePending = new Map<string, Promise<StoreReplica>>()
  let threadReplica: StoreReplica | undefined
  let threadPending: Promise<StoreReplica> | undefined
  // The persisted doc that predates this process (server restart on a durable
  // backend). Folds start from an empty tree, so writes must merge onto this
  // base or the first new turn clobbers the thread's history.
  let threadBase: ThreadDoc | undefined

  // Create the Resource WITH its read grant and AWAIT it before opening — the
  // co-writer's open() auto-creates deny-by-default, so a fire-and-forget create
  // races and the client's read is denied (silently: read denials don't surface
  // as write errors). First write per Resource pays one create round-trip; the
  // rest set synchronously on the cached replica.
  const ensure = async (ns: StoreNs, id: string, initial: unknown): Promise<StoreReplica> => {
    await ns.create?.(id, initial, rules()).catch(() => {})
    return ns.open(id, { origin: 'harness' })
  }

  const mergeThread = (doc: ThreadDoc): ThreadDoc => {
    if (!threadBase) return doc
    return {
      turns: [...threadBase.turns.filter((t) => !doc.turns.includes(t)), ...doc.turns],
      todos: doc.todos ?? threadBase.todos,
      nodes: { ...threadBase.nodes, ...doc.nodes },
    }
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
        threadReplica.set(mergeThread(doc))
        return
      }
      if (!threadPending) {
        threadPending = (async () => {
          const existing = await threadStore.read?.(threadId).catch(() => undefined)
          const data = existing?.data as ThreadDoc | undefined
          if (data && Array.isArray(data.turns) && data.turns.length > 0) threadBase = data
          return ensure(threadStore, threadId, doc)
        })()
      }
      void threadPending.then((r) => {
        threadReplica = r
        r.set(mergeThread(doc))
      })
    },
  }
}
