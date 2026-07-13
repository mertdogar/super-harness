// The lib's built-in tools, injected per-call via `toolsets` (never baked into
// the consumer's Agent). Each reads the per-node HarnessRuntime off
// requestContext. `delegate` spawns a child node; `ask_user` suspends the turn
// (root only); `todo` streams a task list onto the node.

import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { todoItemSchema } from '@super-harness/shared'
import { DELEGATE_TOOL, HARNESS_RUNTIME_KEY, type HarnessRuntime } from './runtime'

function runtimeOf(ctx: ToolExecutionContext): HarnessRuntime {
  const rt = ctx.requestContext?.get(HARNESS_RUNTIME_KEY) as HarnessRuntime | undefined
  if (!rt) throw new Error('harness runtime missing from requestContext')
  return rt
}

export function makeDelegateTool(agentTypes: string[]) {
  return createTool({
    id: DELEGATE_TOOL,
    description:
      'Delegate a self-contained task to a subagent. It runs headless and returns a final report — you never see its intermediate tool calls. Pass the full context it needs; it does not recall earlier delegations unless it is a recall subagent.',
    inputSchema: z.object({
      agentType: z.string().describe(`Which subagent to run. One of: ${agentTypes.join(', ')}`),
      task: z.string().describe('The complete task/brief for the subagent.'),
    }),
    outputSchema: z.object({ content: z.string(), isError: z.boolean() }),
    execute: async ({ agentType, task }, ctx) => {
      const c = ctx as ToolExecutionContext
      const toolCallId = c?.agent?.toolCallId ?? `${agentType}:${task.length}`
      // c.tracing.currentSpan is the delegate TOOL_CALL span — forward it so the
      // child AGENT_RUN nests under it in the same trace (Mastra ≥1.50).
      return runtimeOf(c).delegate(agentType, task, toolCallId, c.tracing)
    },
  })
}

// Root-only. Suspends via Mastra's tool suspend/resume; the answer arrives as
// resumeData on the resumed run.
export const askUserTool = createTool({
  id: 'ask_user',
  description:
    'Ask the human a question and wait for their typed answer. Use only when you need information only the user can provide.',
  inputSchema: z.object({ question: z.string() }),
  suspendSchema: z.object({ question: z.string() }),
  resumeSchema: z.object({ answer: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
  execute: async ({ question }, ctx) => {
    const agent = ctx?.agent
    if (agent?.resumeData) return agent.resumeData as { answer: string }
    await agent?.suspend({ question })
    return { answer: '' }
  },
})

export const todoTool = createTool({
  id: 'todo',
  description: 'Record or update your task list for this turn. Send the full list each time.',
  inputSchema: z.object({ items: z.array(todoItemSchema) }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ items }, ctx) => {
    const rt = runtimeOf(ctx as ToolExecutionContext)
    rt.emit({ ...rt.node, type: 'todo', items })
    return { ok: true }
  },
})
