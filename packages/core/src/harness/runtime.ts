// The per-node runtime handed to built-in tools via requestContext.get('harness').
// Each node's runner sets its own instance (closure over that node's envelope),
// so a tool reads the runtime for the node it's executing in.

import type { HarnessEvent } from '@super-harness/shared'
import type { NodeEnvelope } from './run-node'

export const HARNESS_RUNTIME_KEY = 'harness'
export const DELEGATE_TOOL = 'delegate'

export interface HarnessRuntime {
  node: NodeEnvelope
  emit(event: HarnessEvent): void
  // toolCallId is the delegate tool call's id — it becomes the child node's id.
  delegate(agentType: string, task: string, toolCallId: string): Promise<{ content: string; isError: boolean }>
}
