# Worked examples

## 1. Embedded CLI chat (core only)

```ts
import { Agent } from '@mastra/core/agent'
import { Memory } from '@mastra/memory'
import { LibSQLStore } from '@mastra/libsql'
import { gateway } from '@ai-sdk/gateway'
import { createHarness } from '@super-harness/core'

const storage = new LibSQLStore({ id: 'app', url: 'file:./app.db' })
const mem = () => new Memory({ storage, options: { lastMessages: 10 } })

const worker = new Agent({
  id: 'worker', name: 'Worker', model: gateway('anthropic/claude-haiku-4.5'),
  instructions: 'Do the task with your tools; report concretely.',
  tools: { search: searchTool }, memory: mem(),
})
const supervisor = new Agent({
  id: 'supervisor', name: 'Supervisor', model: gateway('anthropic/claude-haiku-4.5'),
  instructions: 'Delegate research to `worker` via the delegate tool; summarize.',
  memory: mem(),
})

const harness = createHarness({ supervisor, subagents: [{ agent: worker }], memory: mem() })

const threadId = 'cli-session'
for await (const line of console) {
  const res = await harness.sendMessage({ threadId, content: line })
  if (res.status === 'done') console.log(res.text)
  if (res.status === 'suspended') {
    const answer = prompt(String(res.suspension.suspendPayload))   // ask_user round-trip
    const r2 = await harness.resume({ threadId, resumeData: answer })
    if (r2.status === 'done') console.log(r2.text)
  }
}
```

## 2. Token streaming from the bus

```ts
harness.subscribe((threadId, e) => {
  switch (e.type) {
    case 'text_delta':    process.stdout.write(e.text); break        // any depth
    case 'node_start':    console.log(`\n[${e.agentType} started]`); break
    case 'node_end':      console.log(`\n[${e.agentType} done]`); break
  }
})
```

Raw node events are enveloped with `nodeId`/`agentType`/`depth` — subagent
streams arrive with full fidelity, filter on `depth === 0` for root-only UI.

## 3. Approval round-trip (HITL tool gating)

```ts
const harness = createHarness({
  supervisor,                                  // supervisor owns the gated tool
  subagents: [{ agent: worker }],
  permissions: { tools: { deploy: 'ask', rm_rf: 'deny' } },
})

harness.subscribe(async (threadId, e) => {
  if (e.type !== 'approval_required') return
  const yes = await askHuman(`Allow ${e.toolName}(${JSON.stringify(e.args)})?`)
  await harness.respondToApproval({
    threadId,
    toolCallId: e.toolCallId,
    decision: yes ? 'approve' : 'decline',     // or 'always_allow' to grant for the session
    message: yes ? undefined : 'blocked by operator',
  })
})

await harness.sendMessage({ threadId, content: 'deploy to prod' })
// turn suspends at the deploy call, continues after respondToApproval resolves it
```

## 4. Full server (condensed dev-server)

See `examples/dev-server/server.ts` for the complete runnable version —
supervisor + worker with a live weather tool, two modes, LibSQL-backed Mastra
memory, served over `webSocketServerTransport` on `/super-line`. Run it:

```bash
pnpm -F @super-harness/dev-server start
pnpm -F @super-harness/tui start -- --url ws://localhost:4111/super-line
```

## 5. Web client with live tree + approvals

```ts
await client.join({ threadId })

let prev = emptyTree()
subscribeTree(client, threadId, (tree) => {
  for (const e of diffTree(prev, tree)) applyToUi(e)   // token-level updates
  prev = tree
})

client.on('suspended', async (e) => {                   // ask_user from the agent
  const answer = await modal(e.request)
  await client.resumeMessage({ threadId, toolCallId: e.toolCallId, resumeData: answer })
})
client.on('approvalRequired', async (e) => {
  const d = await approvalDialog(e.toolName, e.args)
  await client.respondToApproval({ threadId, toolCallId: e.toolCallId, decision: d })
})

await client.sendMessage({ threadId, message: 'hello' })
```

## 6. Modes + threads

```ts
const harness = createHarness({
  supervisor, subagents,
  memory: new Memory({ storage }),             // required for persistence + listing
  generateTitle: true,                         // auto-title from the first message → thread_renamed
  modes: [
    { id: 'chat',  name: 'Chat',  instructions: 'Conversational.', metadata: { default: true } },
    { id: 'audit', name: 'Audit', instructions: 'Cite evidence for every claim.',
      availableTools: ['search'] },            // built-ins are always re-added
  ],
})

const t = await harness.threads.create({ title: 'Q3 review' })
await harness.switchMode(t.id, 'audit')        // persists as harnessModeId in thread metadata
await harness.sendMessage({ threadId: t.id, content: 'audit the numbers' })
console.log(await harness.threads.list())      // survives restart via Memory storage
```

## 7. Cross-tab thread list (resource scoping)

A resource's tabs stay in sync through the resource room — no polling. Connect
each tab with a shared `resourceId` (via the server's `authenticate`), then:

```ts
const client = createHarnessClient({ url, params: { userId: 'me', resourceId: 'me' } })

client.on('threadCreated', (t) => addToSidebar(t))        // a sibling tab (or createThread)
client.on('threadRenamed', ({ threadId, title }) => renameInSidebar(threadId, title)) // incl. auto-titles
client.on('threadDeleted', ({ threadId }) => removeFromSidebar(threadId))

const { threads } = await client.listThreads({})          // scoped to this resource, server-side
```

`@super-harness/react` wires all three into `state.threads` for you (and flags a
remotely-deleted active thread as `state.activeThreadDeleted`).
