import { Agent } from '@mastra/core/agent'
import { Memory } from '@mastra/memory'
import { gateway } from '@ai-sdk/gateway'
import { askUserTool } from '../tools/ask-user-tool'
import { workerAgent } from './worker-agent'
import { storage } from '../storage'

export const chatAgent = new Agent({
  id: 'chat-agent',
  name: 'Chat Agent',
  instructions: `You are a friendly, concise chat assistant.
For anything needing live data or focused work — e.g. a weather lookup, comparing several cities, or reading/writing files — delegate to the worker subagent (one delegation per distinct task), then summarize what it returns.
For multi-part requests, first sketch a short plan with the todo_write tool, mark items in_progress / completed as you go, and finally synthesize the workers' results into one short reply.
When you need information only the user can provide — a missing value, a choice, a clarification — use the ask-user tool. Its answer arrives as the user's next message, so end the turn after asking.
Keep the user profile in working memory current: when the user reveals their name, location, interests, or preferences, record it; use what you already know to personalize replies instead of re-asking.
Keep replies short and conversational.`,
  model: gateway(process.env.CHAT_MODEL ?? 'anthropic/claude-sonnet-4.5'),
  tools: { askUserTool },
  // askUserTool lives here (not on the worker) so a suspension sits on the
  // memory-holding agent; autoResumeSuspendedTools then continues it from the
  // user's next message on the same thread.
  defaultOptions: { autoResumeSuspendedTools: true },
  // Native Mastra supervisor: the worker is delegated to in-process as an
  // `agent-worker-agent` tool; its stream propagates up.
  agents: { workerAgent },
  memory: new Memory({
    storage,
    options: {
      lastMessages: 20,
      // Resource-scoped: the profile persists across all of this user's threads.
      workingMemory: {
        enabled: true,
        scope: 'resource',
        template: `# User Profile
- **Name**:
- **Location**:
- **Interests**:
- **Preferences**:
`,
      },
      generateTitle: {
        model: gateway('anthropic/claude-haiku-4.5'),
        instructions: 'Generate a short 3-5 word title for the conversation. No quotes, no trailing punctuation.',
      },
    },
  }),
})
