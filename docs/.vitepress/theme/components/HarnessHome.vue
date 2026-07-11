<script setup lang="ts">
import { withBase } from 'vitepress'

const contractCode = `// Your app owns the agents, auth, and server.
const engine = createHarness({
  supervisor,
  subagents: [{ agent: researcher }],
  permissions: { tools: { deploy: 'ask' } },
})

const contract = defineContract({
  plugins: [harnessContract()],
  roles: { user: {} },
})

createSuperLineServer(contract, {
  collections: sqliteCollections({ file: './harness.db' }),
  identify: (connection) => connection.ctx.userId,
  plugins: [harness(engine)],
})`

const treeCode = `thread: product-research
├─ supervisor                         streaming
│  ├─ todo  2 / 3 complete
│  └─ delegate → researcher
│     ├─ reasoning                    streaming
│     ├─ search_web                   complete
│     └─ answer                       complete
└─ approval: deploy                   waiting for you`
</script>

<template>
  <main class="sh-home">
    <section class="sh-hero">
      <div class="sh-hero__copy">
        <p class="sh-kicker"><span /> Multi-agent systems, made inspectable</p>
        <h1>Every agent step.<br /><em>One live tree.</em></h1>
        <p class="sh-lede">
          A durable harness for Mastra agents. Delegate work, stream every nested
          tool call, and bring people in at the exact moment they matter.
        </p>
        <div class="sh-actions">
          <a class="VPButton brand" :href="withBase('/tutorials/first-harness')">
            Get started
          </a>
          <a class="VPButton alt" href="https://github.com/mertdogar/super-harness">View on GitHub</a>
        </div>
      </div>
      <section class="sh-tree" aria-label="A live agent session tree">
        <div class="sh-tree__bar"><i /> LIVE SESSION <b>00:14</b></div>
        <pre><code>{{ treeCode }}</code></pre>
        <div class="sh-tree__status"><span /> connected · durable · replayable</div>
      </section>
    </section>

    <section class="sh-proof">
      <div class="sh-section-heading">
        <p>One integration point</p>
        <h2>Your server stays yours.</h2>
        <span>Super Harness is a super-line plugin, not another service to operate.</span>
      </div>
      <div class="sh-code"><div class="sh-code__bar"><span /><span /><span /> server.ts</div><pre><code>{{ contractCode }}</code></pre></div>
    </section>

    <section class="sh-principles">
      <article><b>01</b><h3>Full-fidelity streaming</h3><p>Reasoning, tool input, results, and every subagent branch arrive as their own first-class events.</p></article>
      <article><b>02</b><h3>Durable by default</h3><p>Structural state persists as typed collections, so reloads, reconnects, and late joiners see the actual run.</p></article>
      <article><b>03</b><h3>Human control where it counts</h3><p>Pause for answers, gate sensitive tools, and continue the exact session without rebuilding orchestration.</p></article>
    </section>

    <section class="sh-next">
      <p>Start with a working harness</p>
      <h2>From agents to an observable system.</h2>
      <a :href="withBase('/tutorials/first-harness')">
        Build your first harness <span>→</span>
      </a>
    </section>
  </main>
</template>
