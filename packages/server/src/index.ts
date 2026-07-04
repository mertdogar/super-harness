// Public API of @super-harness/server: the super-line binding. Build a Harness
// with @super-harness/core (transport-free), then either serve() it standalone
// or compose it into a host super-line server (harnessStores + mountHarness).
// The wire contract and client view live in @super-harness/shared.
export {
  serve,
  harnessStores,
  mountHarness,
  type ServeConfig,
  type HarnessServer,
  type HarnessStorage,
  type HarnessStoreMap,
  type HarnessCtx,
  type HarnessHandlers,
  type HarnessHost,
  type HarnessMount,
} from './serve'
export { superlineTreeSink } from './sink'
export { libsqlStoreServer, pgStoreServer, type LibsqlClientLike, type PgDbLike } from './stores'
