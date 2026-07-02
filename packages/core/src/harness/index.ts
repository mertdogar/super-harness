export {
  createController,
  Controller,
  type ControllerConfig,
  type SubagentConfig,
  type EngineConfig,
  type SubagentEntry,
  type RunResult,
} from './controller'
export { Projector } from './projector'
export { memoryTreeSink, type TreeSink, type MemoryTreeSink } from './sink'
export { runNode, type AgentRunner, type RunOptions, type NodeEnvelope, type StreamResult, type RunNodeResult } from './run-node'
export { createChunkAdapter, type ChunkLike, type ChunkAdapter, type Suspension } from './chunk-adapter'
export { HARNESS_RUNTIME_KEY, DELEGATE_TOOL, type HarnessRuntime } from './runtime'
export { makeDelegateTool, askUserTool, todoTool } from './tools'

// Re-export the pure isomorphic layer for convenience (canonical home:
// @super-harness/shared). The super-line contract deliberately does NOT
// ride along — it belongs to @super-harness/server and clients.
export {
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
