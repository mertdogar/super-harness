export { createHarness, type Harness, type HarnessConfig, type SubagentConfig } from './harness'
export { Session, type SessionConfig, type SubagentEntry } from './session'
export { Projector } from './projector'
export { memoryTreeSink, superlineTreeSink, type TreeSink, type MemoryTreeSink } from './sink'
export { runNode, type AgentRunner, type RunOptions, type NodeEnvelope, type StreamResult, type RunNodeResult } from './run-node'
export { createChunkAdapter, type ChunkLike, type ChunkAdapter, type Suspension } from './chunk-adapter'
export { HARNESS_RUNTIME_KEY, DELEGATE_TOOL, type HarnessRuntime } from './runtime'
export { makeDelegateTool, askUserTool, todoTool } from './tools'

// Re-export the isomorphic layer for convenience (canonical home: @super-harness/shared)
export {
  contract,
  type Contract,
  suspendedSchema,
  type Suspended,
  harnessEventSchema,
  type HarnessEvent,
  type HarnessEventType,
  type TokenUsage,
  type TodoItem,
  apply,
  initialTree,
  type HarnessTree,
  type ThreadDoc,
  type NodeState,
  type ToolState,
  type NodeStatus,
  type ToolStatus,
} from '@super-harness/shared'
