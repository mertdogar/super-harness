export {
  createHarness,
  Harness,
  HarnessThreads,
  type HarnessConfig,
  type SubagentConfig,
  type EngineConfig,
  type SubagentEntry,
  type RunResult,
  type SendResult,
  type HarnessMode,
  type TurnContextArgs,
  type HarnessSessionEvent,
  type HarnessBusEvent,
  type HarnessListener,
  type PermissionRules,
  type PermissionPolicy,
  type ToolCategory,
  type ApprovalDecision,
  type ThreadStore,
  type ThreadRecord,
  type ThreadInfo,
} from './harness'
export { Projector } from './projector'
export { memoryTreeSink, type TreeSink, type MemoryTreeSink } from './sink'
export {
  runNode,
  type AgentRunner,
  type RunOptions,
  type NodeEnvelope,
  type StreamResult,
  type RunNodeResult,
  type ApprovalRequest,
} from './run-node'
export { createChunkAdapter, type ChunkLike, type ChunkAdapter, type Suspension } from './chunk-adapter'
export { HARNESS_RUNTIME_KEY, DELEGATE_TOOL, type HarnessRuntime } from './runtime'
export { makeDelegateTool, askUserTool, todoTool } from './tools'

// Re-export the pure isomorphic layer for convenience (canonical home:
// @super-harness/shared). The super-line contract deliberately does NOT
// ride along — it belongs to @super-harness/server and clients.
export {
  harnessEventSchema,
  type FileAttachment,
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
