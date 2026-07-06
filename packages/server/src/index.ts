// Public API of @super-harness/server: the super-line binding as a PLUGIN.
// Build a Harness with @super-harness/core (transport-free), then either serve()
// it standalone or add harness(engine) to a host super-line server's `plugins`
// (merging harnessContract() into the host contract). The wire contract, row
// schemas, and client view live in @super-harness/shared.
export { serve, type ServeConfig, type HarnessServer, type HarnessStorage } from './serve'
export { harness, type HarnessCtx, type HarnessPluginOptions } from './plugin'
export { collectionsTreeSink, type CollectionsTreeSink, type Collections, type CollectionHandleLike } from './sink'
// Re-export the contract-time fragment so a host can grab both halves from here.
export { harnessContract } from '@super-harness/shared'
