// Real-1.50 delegate-tracing regression check (NOT a vitest test — the repo's
// suite is fakes-only/no-network; this needs a live model). Runs one forced
// delegation (supervisor -> worker) through createHarness against real
// @mastra/core with an in-memory TestExporter, then asserts the whole turn is
// ONE Mastra trace. A green mock-based unit test is not enough here — this is
// the check that would have caught the earlier ctx.tracing regression.
//
//   pnpm -F @super-harness/dev-server exec tsx trace-probe.ts
//
// Skips (exit 0) without AI_GATEWAY_API_KEY; exits 1 if the turn fragments.

import { readFileSync } from "node:fs"
import { Agent } from "@mastra/core/agent"
import { Mastra } from "@mastra/core"
import { Memory } from "@mastra/memory"
import { LibSQLStore } from "@mastra/libsql"
import { Observability, TestExporter } from "@mastra/observability"
import { gateway } from "@ai-sdk/gateway"
import { createHarness } from "@super-harness/core"

// Minimal root-.env loader — no runtime env-file flag needed.
try {
  for (const line of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "")
  }
} catch {
  /* no .env file — rely on the ambient environment */
}
if (!process.env.AI_GATEWAY_API_KEY) {
  console.log("SKIP: AI_GATEWAY_API_KEY not set — real-model tracing check skipped.")
  process.exit(0)
}

const MODEL = process.env.CHAT_MODEL ?? "anthropic/claude-haiku-4.5"
const store = new LibSQLStore({ id: "probe", url: "file::memory:?cache=shared" })
const mem = () => new Memory({ storage: store, options: { lastMessages: 5 } })

const worker = new Agent({
  id: "worker",
  name: "Worker",
  instructions: "You are a focused worker. Answer the task in one short sentence.",
  model: gateway(MODEL),
  memory: mem(),
})

const supervisor = new Agent({
  id: "supervisor",
  name: "Supervisor",
  instructions:
    "You coordinate a `worker` subagent. For ANY task you MUST delegate to the worker via the delegate tool (never answer yourself), then relay its report in one short sentence.",
  model: gateway(MODEL),
  memory: mem(),
})

const exporter = new TestExporter({ logMetricsOnFlush: false, validateLifecycle: false })

// Registering the agents on a Mastra with observability is what makes
// agent.stream() emit spans — the same wiring a production host uses.
new Mastra({
  agents: { supervisor, worker },
  observability: new Observability({
    configs: { default: { serviceName: "trace-probe", exporters: [exporter] } },
  }),
})

const harness = createHarness({ supervisor, subagents: [{ agent: worker }] })

const res = await harness.sendMessage({
  threadId: "probe-1",
  content: "Ask the worker to name one landmark in Istanbul.",
})
console.log("\nturn result:", res.status)

await exporter.flush()
const vfs = exporter.validateFinalState()

console.log("\nspan structure:")
for (const line of exporter.generateStructureGraph()) console.log("  " + line)
console.log("\nagent_run spans:")
for (const s of exporter.getSpansByType("agent_run") as any[]) {
  console.log(`  ${JSON.stringify(s.name)}  traceId=${s.traceId}  id=${s.id}  parentSpanId=${s.parentSpanId ?? "(root)"}`)
}

if (!vfs.singleTraceId) {
  console.error(`\nFAIL: turn fragmented into ${vfs.traceIds.length} traces:`, vfs.traceIds)
  process.exit(1)
}
console.log(`\nOK: single trace ${vfs.traceIds[0]} — supervisor + worker share one trace.`)
process.exit(0)
