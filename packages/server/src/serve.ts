// The standalone host: the harness-only contract on its own super-line server,
// built from the SAME pieces a composing host uses — `plugins: [harness()]` over
// a collections backend. A host app instead merges harnessContract() into its
// own contract and adds harness(engine) to its own plugins (see examples).

import type { Adapter, CollectionStore, ServerTransport } from '@super-line/core'
import { createSuperLineServer, type SuperLinePlugin } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { contract } from '@super-harness/shared'
import type { Harness } from '@super-harness/core'
import { harness, type HarnessCtx, type HarnessPluginOptions } from './plugin'

// Where the harness collections live. sqlite (default) owns its own file;
// memory is for tests/dev; pglite is the multi-node choice (central Postgres +
// Electric-synced replicas — an optional peer, loaded only when selected).
export type HarnessStorage =
  | { type: 'memory' }
  | { type: 'sqlite'; file?: string }
  | { type: 'pglite'; pgUrl: string; electricUrl?: string }

async function collectionsFor(storage: HarnessStorage): Promise<CollectionStore> {
  switch (storage.type) {
    case 'memory':
      return memoryCollections()
    case 'pglite': {
      const { pgliteCollections } = await import('@super-line/collections-pglite')
      return pgliteCollections({ pgUrl: storage.pgUrl, electricUrl: storage.electricUrl })
    }
    default:
      return sqliteCollections({ file: storage.file ?? './harness.db' })
  }
}

export interface ServeConfig {
  storage?: HarnessStorage
  transports?: ServerTransport[]
  adapter?: Adapter
  // Shapes each connection's ctx (userId is the collection principal; resourceId
  // scopes the thread list). Default: read userId/resourceId from the handshake
  // query — dev/trusted only. In production pair with @super-line/plugin-auth.
  authenticate?: (handshake: unknown) => { role: 'user'; ctx: HarnessCtx }
  // Membership role policy passed through to the harness() plugin.
  plugin?: HarnessPluginOptions
  // Extra super-line plugins to compose beside harness() — e.g. inspector()
  // (@super-line/plugin-inspector) or auth() (@super-line/plugin-auth). Mounted
  // after harness() in array order.
  plugins?: SuperLinePlugin[]
}

export interface HarnessServer {
  server: ReturnType<typeof createSuperLineServer>
  // Tear down the server (disposes the harness plugin's bus subscription). The
  // transports/http server are the caller's to close.
  close(): void
}

const defaultAuthenticate = (h: unknown): { role: 'user'; ctx: HarnessCtx } => {
  const q = (h as { query?: Record<string, string> })?.query ?? {}
  // resourceId stays undefined when absent (list-all via membership fallback);
  // userId falls back to it, then 'local', for the collection principal.
  return { role: 'user', ctx: { userId: q.userId ?? q.resourceId ?? 'local', resourceId: q.resourceId } }
}

export async function serve(engine: Harness, config: ServeConfig = {}): Promise<HarnessServer> {
  const collections = await collectionsFor(config.storage ?? { type: 'sqlite' })
  const server = createSuperLineServer(contract, {
    transports: config.transports ?? [],
    authenticate: config.authenticate ?? defaultAuthenticate,
    identify: (conn: { ctx: HarnessCtx }) => conn.ctx.userId,
    collections,
    plugins: [harness(engine, config.plugin), ...(config.plugins ?? [])],
    adapter: config.adapter,
  } as never)

  // harness.* is owned by the plugin (subtracted from implement); the empty
  // `user` role has no requests of its own.
  server.implement({} as never)

  return { server, close: () => void server.close() }
}
