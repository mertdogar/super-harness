import { Agent } from '@mastra/core/agent'
import { gateway } from '@ai-sdk/gateway'
import { weatherTool } from '../tools/weather-tool'

// Stateless worker spawned per task. No memory and no subagent of its own, so the
// tree can't recurse infinitely. Headless: if it lacks information only the user
// can give, it reports that back so the supervisor (which owns ask-user) asks.
export const workerAgent = new Agent({
  id: 'worker-agent',
  name: 'Worker',
  instructions: `You are a focused worker subagent. Complete the single task you are given using your tools, then report a short, concrete result. You have a workspace for reading and writing files. If you are missing information only the user can provide, say so in your result instead of asking; do not ask follow-up questions yourself.`,
  model: gateway(process.env.CHAT_MODEL ?? 'anthropic/claude-sonnet-4.5'),
  tools: { weatherTool },
})
