import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { type HonoBindings, type HonoVariables, MastraServer } from '@mastra/hono'
import { makeMastra } from './mastra'

const PORT = Number(process.env.PORT ?? 4111)

const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>()
app.use('*', cors())

const httpServer = createServer(getRequestListener(app.fetch))
const mastra = makeMastra()

const server = new MastraServer({ app, mastra })
await server.init()

httpServer.listen(PORT, () => {
  console.log(`[server] http + super-line on http://localhost:${PORT}`)
})
