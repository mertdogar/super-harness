import { Mastra } from '@mastra/core'
import { PinoLogger } from '@mastra/loggers'
import { chatAgent } from './agents/chat-agent'
import { workerAgent } from './agents/worker-agent'
import { storage } from './storage'
import { CachingPubSub, EventEmitterPubSub } from '@mastra/core/events'
import { InMemoryServerCache } from '@mastra/core/cache'

const cache = new InMemoryServerCache()

export function makeMastra() {
  return new Mastra({
    agents: { chatAgent, workerAgent },
    pubsub: new CachingPubSub(new EventEmitterPubSub(), cache),
    storage,
    logger: new PinoLogger({ name: 'Mastra', level: 'info' }),
  })
}
