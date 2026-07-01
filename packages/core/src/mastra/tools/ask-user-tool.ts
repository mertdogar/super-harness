import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

// Browser-roundtrip tool: suspend the turn with a question, resume with the typed
// answer. The general client-side tool primitive (the shape a geolocation or
// file-picker tool would use): suspend with a request, resume with the result.
export const askUserTool = createTool({
  id: 'ask-user',
  description:
    'Ask the human a question and wait for their typed answer. Use when you need information only the user can provide — a choice, a value, or a clarification.',
  inputSchema: z.object({
    question: z.string().describe('The question to put to the user'),
  }),
  suspendSchema: z.object({ question: z.string() }),
  resumeSchema: z.object({ answer: z.string() }),
  outputSchema: z.object({ answer: z.string() }),
  execute: async ({ question }, context) => {
    const agent = context?.agent
    if (agent?.resumeData) return agent.resumeData
    await agent?.suspend({ question })
    return { answer: '' }
  },
})
