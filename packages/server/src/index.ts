// Public API of @super-harness/server: the batteries-included super-line
// binding. The pure engine lives in @super-harness/core; the wire contract and
// client view live in @super-harness/shared.
export { createHarness, type Harness, type HarnessConfig, type SubagentConfig } from './harness'
export { superlineTreeSink } from './sink'
