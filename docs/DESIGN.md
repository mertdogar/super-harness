---
name: Super Harness documentation
description: Durable multi-agent streams, composed into super-line.
colors:
  deep-cyan: "#075985"
  bright-cyan: "#0284c7"
  active-cyan: "#0ea5e9"
  ink: "#101827"
  code-ink: "#0b1220"
  code-text: "#d8e5f4"
  code-muted: "#8ca1b9"
  stream-green: "#38d996"
  dark-page: "#0b101a"
  dark-surface: "#121a27"
  dark-cyan: "#38bdf8"
  dark-cyan-hover: "#7dd3fc"
typography:
  display:
    fontFamily: "system-ui, sans-serif"
    fontSize: "clamp(3rem, 6vw, 5rem)"
    fontWeight: 700
    lineHeight: 0.99
    letterSpacing: "-0.04em"
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 700
    letterSpacing: "0.08em"
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    lineHeight: 1.85
rounded:
  control: "7px"
  code: "10px"
  stream: "12px"
spacing:
  compact: "12px"
  code: "24px"
  edge: "36px"
  section: "100px"
  feature: "110px"
components:
  button-primary:
    backgroundColor: "{colors.deep-cyan}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "12px 19px"
  button-primary-hover:
    backgroundColor: "{colors.bright-cyan}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "12px 19px"
  stream-frame:
    backgroundColor: "{colors.code-ink}"
    textColor: "{colors.code-text}"
    rounded: "{rounded.stream}"
    padding: "24px"
  code-frame:
    backgroundColor: "{colors.code-ink}"
    textColor: "{colors.code-text}"
    rounded: "{rounded.code}"
    padding: "25px"
---

# Design System: Super Harness documentation

## Overview

**Creative North Star: "The Composed Trace"**

The documentation site is a public engineering surface, not an agent dashboard.
It visualizes the durable path through a multi-agent run: a supervisor branches
into subagents, each branch streams, and the completed structure remains
available. The design keeps the reader oriented around that composition rather
than decorating the page with abstract AI imagery.

Use a restrained VitePress documentation shell around a small set of vivid,
evidence-bearing artifacts: the live tree, the server composition snippet, and
the local-run path. Cyan marks active system paths; the deep code surface holds
execution proof; green is reserved for live or settled stream state. Surfaces
are mostly flat, and elevation signals an artifact that the reader can inspect.

**Key Characteristics:**

- Cyan identifies the super-line family without overwhelming long-form docs.
- Code and execution trees are evidence, not decoration.
- The supervisor/subagent hierarchy remains visually legible at every width.
- A host keeps ownership of its server, socket, authentication, and storage.
- Light and dark themes retain the same hierarchy and interaction meaning.

## Colors

The palette is a cyan-on-ink system: an exact, technical accent against calm
documentation surfaces, with one green status signal for stream life cycle.

### Primary

- **Composed Cyan** (`#075985`): primary links, light-theme controls, and
  structural emphasis.
- **Active Path Cyan** (`#0ea5e9`): the brighter signal used in the mark and
  live execution emphasis.
- **Stream Green** (`#38d996`): do not use it as a brand
  substitute; it is reserved for status.

### Secondary

- **Bright Cyan** (`#0284c7`): hover state for Composed Cyan controls.
- **Dark-Mode Cyan** (`#38bdf8`): high-contrast primary action color on the
  dark page surface.
- **Dark-Mode Cyan Hover** (`#7dd3fc`): hover and high-emphasis text in dark
  mode.

### Neutral

- **Harness Ink** (`#101827`): light-theme hero heading ink.
- **Code Ink** (`#0b1220`): code and stream-frame background.
- **Code Text** (`#d8e5f4`): primary text on Code Ink.
- **Trace Muted** (`#8ca1b9`): timestamps, labels, and secondary text in code
  and stream frames.
- **Night Page** (`#0b101a`): dark-theme page background.
- **Night Surface** (`#121a27`): dark-theme raised documentation surface.

### Named Rules

**The Evidence Color Rule.** Cyan identifies composition or action; green only
identifies live or complete stream state. Neither color may be used as a
generic decorative flourish.

## Typography

**Display Font:** system UI sans serif

**Body Font:** system UI sans serif

**Label/Mono Font:** `ui-monospace`, `SFMono-Regular`, `Menlo`, monospace

**Character:** The sans serif system keeps explanatory prose immediate and
browser-native. Monospace appears only where it carries system information:
code, stream nodes, timestamps, and status labels.

### Hierarchy

- **Display** (700, `clamp(3rem, 6vw, 5rem)`, `0.99`): hero statement only.
  Keep tracking no tighter than `-0.04em` in new work.
- **Headline** (700, `clamp(2rem, 3.4vw, 3.0625rem)`, `1.04`): major section
  statements and the end-of-page conversion moment.
- **Title** (700, `1.3125rem`, normal): individual principle headings.
- **Body** (400, `1rem`, `1.6`): documentation prose; cap reading measure at
  roughly 65–75 characters.
- **Label** (700, `0.6875rem`, `0.08em`): short stream headers and metadata,
  never paragraph copy.
- **Code** (400, `0.8125rem`, `1.85`): executable snippets and live-tree
  state, with horizontal overflow rather than compressed source.

### Named Rules

**The Mechanism Rule.** Use mono only when the reader is looking at an actual
system mechanism. Mono is not a decorative synonym for developer credibility.

## Elevation

The system is flat by default. Borders establish the frame of a code artifact
or live stream. A broad shadow appears only beneath the hero's inspectable
proof panels, where it separates the running system from the explanatory page.

### Shadow Vocabulary

- **Execution Artifact** (`0 22px 55px rgba(5, 21, 37, 0.18)`): hero stream
  tree and code proof only. Pair it with the existing dark artifact surface,
  not with generic documentation cards.

### Named Rules

**The Artifact Elevation Rule.** If a surface is not code, a trace, or a live
execution artifact, use spacing and tonal contrast before reaching for shadow.

## Components

### Buttons

Buttons are crisp, compact controls rather than soft marketing pills.

- **Shape:** `7px` radius with `12px 19px` padding.
- **Primary:** Composed Cyan with white text in light mode; Dark-Mode Cyan
  with dark text in dark mode.
- **Hover / Focus:** brighten the cyan and use a visible focus indicator that
  does not rely on color alone.
- **Secondary:** use the VitePress alternate treatment for GitHub or a lower
  commitment path; don't add a third decorative CTA style.

### Cards / Containers

The design does not use generic feature cards. The meaningful containers are
the stream frame and the code frame.

- **Stream frame:** `12px` corners, Code Ink, a thin `#263449` border, a
  42px status header, and compact monospace status text.
- **Code frame:** `10px` corners, Code Ink, a thin `#263449` border, and
  `25px` internal padding.
- **Principle row:** use a top border and generous space instead of a card.

### Navigation

Navigation stays documentation-first: readable section names, local search,
light/dark appearance control, and a GitHub escape hatch. Active state must
combine cyan with weight or another non-color signal.

### Execution Tree

The execution tree is the signature component. It shows a thread, a
supervisor, nested subagents, streaming work, completed work, and approval
state as one hierarchy. Preserve the indentation and alignment; never replace
it with a flattened activity feed.

## Do's and Don'ts

### Do:

- **Do** lead with the super-line plugin boundary before secondary features.
- **Do** use the stream tree and real server composition code as the primary
  visual proof.
- **Do** reserve `#38d996` for a live or settled status signal.
- **Do** let a host retain its own server, socket, authentication, and storage
  in visual and written examples.
- **Do** use `prefers-reduced-motion` alternatives for any future animation.

### Don't:

- **Don't** present Super Harness as a separate agent platform with another
  server, socket, authentication layer, or storage system.
- **Don't** flatten subagents into generic events or tool results.
- **Don't** treat durability as a logging layer added after a run.
- **Don't** use generic AI-orchestration marketing, neon constellations, or
  abstract network graphics in place of the plugin boundary and hierarchy.
- **Don't** use gradient text, glassmorphism, or mono text as a decorative
  technical costume.
- **Don't** use colored side-stripe cards or wide soft shadows on ordinary
  content containers.
