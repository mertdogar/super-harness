// Server-side fold: consumes the internal HarnessEvent stream, maintains one
// long-lived tree per conversation, and mirrors each touched node + the thread
// skeleton into the durable Store via a TreeSink. This is the reducer moved
// server-side (the client just renders the synced Store, no client-side fold).

import { apply, initialTree, type HarnessEvent, type HarnessTree, type ThreadDoc, type TodoItem } from '@super-harness/shared'
import type { TreeSink } from './sink'

export class Projector {
  private tree: HarnessTree = initialTree()
  private todos: TodoItem[] | undefined

  constructor(private sink: TreeSink) {}

  emit(event: HarnessEvent): void {
    if (event.type === 'todo') {
      this.todos = event.items
      this.writeThread()
      return
    }
    const touched = apply(this.tree, event)
    for (const id of touched) this.sink.writeNode(this.tree.nodes[id])
    // Skeleton (structure/turns) only shifts on node lifecycle — cheap to mirror.
    if (event.type === 'node_start' || event.type === 'node_end') this.writeThread()
  }

  private writeThread(): void {
    const nodes: ThreadDoc['nodes'] = {}
    for (const n of Object.values(this.tree.nodes)) {
      nodes[n.nodeId] = { parentNodeId: n.parentNodeId, depth: n.depth, agentType: n.agentType, childOrder: n.childOrder }
    }
    this.sink.writeThread({ turns: this.tree.turns, todos: this.todos, nodes })
  }
}
