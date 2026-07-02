// Public API of @super-harness/server: the super-line binding. Build a Harness
// with @super-harness/core (transport-free), then serve() it. The wire contract
// and client view live in @super-harness/shared.
export { serve, type ServeConfig, type HarnessServer } from './serve'
export { superlineTreeSink } from './sink'
