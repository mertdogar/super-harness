# @super-harness/web-client

Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui web client for the
super-harness. The wire lives in **`@super-harness/react`** (headless
`HarnessClient` + provider/hooks); this app owns only the UI plus the
node-selectbox/thread-in-state glue (`src/main.tsx`) — nothing is in the URL,
so a refresh starts a fresh thread. Not the Vercel AI SDK.

```bash
pnpm -F @super-harness/web-client dev        # vite dev server
pnpm -F @super-harness/web-client build      # tsc -b && vite build
pnpm -F @super-harness/web-client typecheck  # tsc -b
```

## Stack

- Tailwind CSS **v4**, CSS-first via the `@tailwindcss/vite` plugin. Theme lives
  in `src/index.css` (`@import "tailwindcss"`, no `tailwind.config.js`).
- shadcn/ui in CSS-variables mode (`components.json`, style `new-york`, base
  color `neutral`). The `@/*` path alias maps to `src/*` (tsconfig + vite).
- Base shadcn components in `src/components/ui/`; Vercel **ai-elements**
  vendored in `src/components/ai-elements/` (see below).

## The `ai` package is types-only

ai-elements components import types like `UIMessage`, `ToolUIPart`, and
`FileUIPart` from the `ai` package. That's the **only** use of `ai` here — the
transport is super-line, so nothing calls the AI SDK at runtime.

## Vendored ai-elements

Added via the shadcn registry (`pnpm dlx shadcn@latest add https://registry.ai-sdk.dev/<name>.json`),
which resolves each component's shadcn deps and npm deps automatically:

| component      | how                                            |
| -------------- | ---------------------------------------------- |
| conversation   | registry `conversation.json`                   |
| message        | registry `message.json`                        |
| reasoning      | registry `reasoning.json`                      |
| tool           | registry `tool.json` (pulls `code-block`)      |
| prompt-input   | registry `prompt-input.json`                   |
| loader         | registry `loader.json`                         |
| task           | registry `task.json`                           |

(`code-block` rode in with `tool`; `shimmer` with `reasoning`.)

`response` and `actions` are **not** separate components in the current
registry — they were folded into `message` as `MessageResponse` and
`MessageActions` / `MessageAction`.

Regenerate any component with:

```bash
pnpm dlx shadcn@latest add @ai-elements/<name>   # namespace configured in components.json
```

Two vendored files needed a minimal edit for the installed dep versions:

- `tool.tsx` — dropped two stale `@ts-expect-error` directives (the approval
  states they guarded now exist in the installed `ai` types).
- `reasoning.tsx` — `ReasoningContent` no longer forwards the Collapsible DOM
  props onto `<Streamdown>` (streamdown narrows `dir` / animation handlers and
  rejected the spread); the props still apply to the `CollapsibleContent`
  wrapper.
