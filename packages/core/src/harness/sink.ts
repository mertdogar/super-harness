// The persistence port: where the projector writes the tree. Core ships only
// the in-memory impl (self-check + zero-dep default); the durable super-line
// Store impl lives in @super-harness/server (superlineTreeSink).

import type { NodeState, ThreadDoc } from '@super-harness/shared'

export type { ThreadDoc }

export interface TreeSink {
  writeNode(node: NodeState): void
  writeThread(doc: ThreadDoc): void
}

export interface MemoryTreeSink extends TreeSink {
  readNode(nodeId: string): NodeState | undefined
  readThread(): ThreadDoc | undefined
}

export function memoryTreeSink(): MemoryTreeSink {
  const nodes = new Map<string, NodeState>()
  let thread: ThreadDoc | undefined
  return {
    writeNode: (node) => void nodes.set(node.nodeId, structuredClone(node)),
    writeThread: (doc) => void (thread = structuredClone(doc)),
    readNode: (id) => nodes.get(id),
    readThread: () => thread,
  }
}
