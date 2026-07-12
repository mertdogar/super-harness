# Product

## Register

brand

## Platform

web

## Users

Super Harness speaks equally to TypeScript developers evaluating a multi-agent
runtime and AI product teams building production agent experiences. They arrive
with Mastra agents, tools, models, and memory already in mind. Many also use
super-line and want to add multi-agent execution without operating a second
server, connection, authentication system, or storage layer.

Their immediate job is to understand how Super Harness composes with
super-line, then run a working supervisor-and-subagents example locally. They
expect exact technical claims, runnable code, and an architecture they can
inspect before adopting it.

## Product Purpose

Super Harness is a super-line plugin for durable multi-agent streams. It runs a
Mastra-compatible supervisor and subagents, preserves every nested stream at
full fidelity, and exposes the result as durable session state over the host's
existing super-line connection.

The documentation site is the product's front door. Success means a visitor
understands the plugin model, sees why the streams are durable by nature, and
gets a working harness running locally without having to reconstruct the
architecture from package READMEs.

## Positioning

Durable multi-agent streams, composed into super-line.

## Conversion & proof

- Primary CTA: Add the plugin.
- Secondary CTA: Run the Mastra example.
- The line a visitor remembers after 10 seconds: "One plugin. Every agent
  stream. Durable by default."
- Belief ladder: Super Harness is a native super-line plugin; durability is
  part of the stream model rather than an added logging layer; supervisor and
  subagent hierarchy remains intact; existing Mastra agents work directly.
- Proof on hand: the plugin integration code, the live supervisor/subagent
  tree, the runnable local examples, and the repository's implementation and
  tests.

## Brand Personality

Composable, durable, and agent-native. The voice is that of a senior engineer
explaining a system they have built and operated: direct, specific, and
confident enough to show the mechanism. Code and execution structure carry the
argument.

Super Harness belongs beside super-line but has its own subject. Super-line
explains the typed realtime connection; Super Harness explains the durable
supervisor/subagent streams composed onto that connection.

## Anti-references

- A standalone agent platform that introduces another server, socket,
  authentication layer, or storage system.
- Agent frameworks that flatten subagents into generic events or tool results.
- Observability products where durability is a logging layer added after the
  run instead of a property of the stream.
- Generic AI-orchestration marketing that hides the plugin boundary, the
  supervisor hierarchy, or the Mastra integration behind abstract claims.

## Design Principles

1. **Lead with composition.** Show where the plugin joins an existing
   super-line host before describing secondary capabilities.
2. **Make durability concrete.** Demonstrate that reconnects, replay, and
   persisted structure are consequences of the stream model.
3. **Keep the hierarchy intact.** Represent the supervisor and subagents as
   first-class branches, never as a flattened activity feed.
4. **Prove Mastra compatibility with code.** Use real `Agent` instances and
   runnable examples instead of compatibility badges or vague ecosystem copy.
5. **Move quickly from understanding to execution.** Every conceptual claim
   must lead toward adding the plugin or running the local example.

## Accessibility & Inclusion

Target WCAG 2.1 AA in light and dark themes. Keep navigation and interactive
controls keyboard accessible, provide visible focus states, avoid using color
as the only signal, and respect reduced-motion preferences. Code samples and
execution diagrams must remain legible at narrow widths and under browser zoom.
