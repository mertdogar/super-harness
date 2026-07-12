<script setup lang="ts">
import { withBase } from 'vitepress'

const pluginCode = `import { createHarness } from '@super-harness/core'
import { harness } from '@super-harness/server'
import { harnessContract } from '@super-harness/shared'

const engine = createHarness({
  supervisor,
  subagents: [{ agent: researcher }],
})

const app = defineContract({
  plugins: [harnessContract()],
  roles: { user: {} },
})

createSuperLineServer(app, {
  transports,
  collections,
  authenticate,
  identify: (connection) => connection.ctx.userId,
  plugins: [harness(engine)],
})`

const replayTree = `thread: product-research · durable
├─ supervisor                         complete
│  ├─ todo  3 / 3 complete
│  └─ delegate → researcher
│     ├─ reasoning                    complete
│     ├─ search_web                   complete
│     └─ answer                       complete
└─ approval: deploy                   approved
shared state: document · typed CRDT    synced`
</script>

<template>
  <main class="sh-home">
    <section class="sh-hero" aria-labelledby="hero-title">
      <div class="sh-hero__copy">
        <a
          class="sh-super-line"
          href="https://super-line.dogar.biz"
          target="_blank"
          rel="noreferrer"
        >
          <span>A plugin for</span>
          <picture>
            <source media="(prefers-color-scheme: dark)" :srcset="withBase('/super-line-logo-dark.svg')" />
            <img :src="withBase('/super-line-logo-light.svg')" alt="super-line" />
          </picture>
        </a>
        <h1 id="hero-title">
          One plugin.<br />
          <em>Every agent stream.</em><br />
          Durable by default.
        </h1>
        <p class="sh-lede">
          Bring your Mastra supervisor and subagents. Super Harness composes into
          the super-line host you already own and persists every nested stream as
          one replayable session tree.
        </p>
        <div class="sh-actions">
          <a class="sh-action sh-action--primary" :href="withBase('/tutorials/server-plugin')">
            Add the plugin
          </a>
          <a class="sh-action sh-action--secondary" :href="withBase('/tutorials/first-harness')">
            Run the Mastra example
          </a>
        </div>
        <p class="sh-hero__assurance">
          One server, connection, authentication system, and collections backend.
        </p>
      </div>

      <section class="sh-composition" aria-label="A persisted Super Harness replay in a super-line host">
        <div class="sh-composition__header">
          <span>Agent teams, in one stream</span>
          <b>Durable collaboration</b>
        </div>
        <div class="sh-host">
          <div>
            <span>Your existing</span>
            <strong>super-line host</strong>
          </div>
          <ul aria-label="Host resources retained by the application">
            <li>socket</li>
            <li>auth</li>
            <li>storage</li>
          </ul>
        </div>
        <div class="sh-join">
          <span aria-hidden="true">↓</span>
          <code>plugins: [harness(engine)]</code>
        </div>
        <div class="sh-replay">
          <div class="sh-replay__header">
            <span><i /> restored after reconnect</span>
            <b>durable</b>
          </div>
          <pre><code>{{ replayTree }}</code></pre>
          <p>
            Supervisor and subagent branches persist through super-line collections,
            while humans and agents collaborate on the same typed CRDT state.
          </p>
        </div>
      </section>
    </section>

    <section class="sh-proof" aria-labelledby="proof-title">
      <div class="sh-proof__intro">
        <p class="sh-overline">The integration boundary</p>
        <h2 id="proof-title">Your host stays yours.</h2>
        <p>
          Super Harness joins your
          <a href="https://super-line.dogar.biz" target="_blank" rel="noreferrer">super-line server</a>
          as a plugin. It doesn't introduce another service for your team to
          authenticate, deploy, or reconcile.
        </p>
        <code class="sh-install">pnpm add @super-harness/core @super-harness/server @mastra/core</code>
      </div>
      <div class="sh-code">
        <div class="sh-code__bar">
          <span /><span /><span />
          <b>server.ts</b>
          <a :href="withBase('/guides/composition')">Read the complete guide →</a>
        </div>
        <pre><code>{{ pluginCode }}</code></pre>
      </div>
    </section>

    <section class="sh-principles" aria-labelledby="principles-title">
      <div class="sh-principles__intro">
        <p class="sh-overline">Built for the run, not the transcript</p>
        <h2 id="principles-title">Keep the structure that made the work happen.</h2>
      </div>
      <div class="sh-principles__list">
        <article>
          <h3>Preserve hierarchy</h3>
          <p>Supervisor and subagents remain first-class branches, not generic events.</p>
        </article>
        <article>
          <h3>Persist the stream</h3>
          <p>Reconnects and late joiners rebuild the same session without replay glue.</p>
        </article>
        <article>
          <h3>Control the right moment</h3>
          <p>Ask for input or approval inside the durable run, then continue it exactly.</p>
        </article>
      </div>
    </section>

    <section class="sh-next" aria-labelledby="next-title">
      <p class="sh-overline">A working run is the proof</p>
      <h2 id="next-title">Start with the host you already have.</h2>
      <div class="sh-next__actions">
        <a :href="withBase('/tutorials/server-plugin')">Add the plugin <span>→</span></a>
        <a :href="withBase('/tutorials/first-harness')">Run the Mastra example <span>→</span></a>
      </div>
    </section>
  </main>
</template>
