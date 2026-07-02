// Server-side fold: consumes the internal HarnessEvent stream and maintains one
// long-lived tree per conversation. The Harness reads the tree directly (getTree /
// tree_changed); a TreeSink is optional and mirrors each touched node + the
// thread skeleton into durable storage (e.g. super-line Stores in @super-harness/server).

import { apply, initialTree, type HarnessEvent, type HarnessTree, type ThreadDoc, type TodoItem } from '@super-harness/shared'
import type { TreeSink } from './sink'

export class Projector {
  #tree: HarnessTree = initialTree()
  private todos: TodoItem[] | undefined

  constructor(private sink?: TreeSink) {}

  get tree(): HarnessTree {
    return this.#tree
  }

  emit(event: HarnessEvent): void {
    if (event.type === 'todo') {
      this.todos = event.items
      this.writeThread()
      return
    }
    const touched = apply(this.#tree, event)
    if (!this.sink) return
    for (const id of touched) this.sink.writeNode(this.#tree.nodes[id])
    // Skeleton (structure/turns) only shifts on node lifecycle — cheap to mirror.
    if (event.type === 'node_start' || event.type === 'node_end') this.writeThread()
  }

  private writeThread(): void {
    if (!this.sink) return
    const nodes: ThreadDoc['nodes'] = {}
    for (const n of Object.values(this.#tree.nodes)) {
      nodes[n.nodeId] = { parentNodeId: n.parentNodeId, depth: n.depth, agentType: n.agentType, childOrder: n.childOrder }
    }
    this.sink.writeThread({ turns: this.#tree.turns, todos: this.todos, nodes })
  }
}
