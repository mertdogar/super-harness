// The docked prompt above the input bar, shown only while a turn is suspended.
// ask_user → the question + a focused <select> of its options plus a synthetic
// "type your own" escape hatch; a bare approval suspension → Approve / Reject.
// Picking an option resumes immediately; "type your own" hands focus to the input.

import { COLORS } from "./theme"
import type { Pending } from "./session"

const FREEFORM = " freeform"

interface Option {
  name: string
  description: string
  value: string
}

interface Parsed {
  question: string
  options: Option[]
  freeform: boolean
}

function optionLabel(option: unknown): string | null {
  if (typeof option === "string") return option
  const label = (option as { label?: unknown })?.label
  return typeof label === "string" ? label : null
}

function asAskUser(request: unknown): { question: string; options: string[] } | null {
  if (typeof request !== "object" || request === null) return null
  const question = (request as { question?: unknown }).question
  if (typeof question !== "string") return null
  const raw = (request as { options?: unknown }).options
  const options = Array.isArray(raw) ? raw.map(optionLabel).filter((o): o is string => o !== null) : []
  return { question, options }
}

export function parsePending(pending: Pending): Parsed {
  const ask = asAskUser(pending.request)
  if (ask) {
    return {
      question: ask.question,
      options: [
        ...ask.options.map((o) => ({ name: o, description: "", value: o })),
        { name: "✎ Type your own answer", description: "", value: FREEFORM },
      ],
      freeform: true,
    }
  }
  return {
    question: `Approve ${pending.toolName}?`,
    options: [
      { name: "Approve", description: "", value: "yes" },
      { name: "Reject", description: "", value: "no" },
    ],
    freeform: false,
  }
}

export function QuestionDock({
  pending,
  focused,
  onPick,
  onFreeform,
}: {
  pending: Pending
  focused: boolean
  onPick: (value: string) => void
  onFreeform: () => void
}) {
  const parsed = parsePending(pending)
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={COLORS.yellow} paddingLeft={1} paddingRight={1}>
      <text fg={COLORS.yellow}>{`? ${parsed.question}`}</text>
      <select
        focused={focused}
        showDescription={false}
        options={parsed.options}
        onSelect={(_index: number, option: { value?: unknown } | null) => {
          if (!option) return
          const value = String(option.value ?? "")
          if (value === FREEFORM) onFreeform()
          else onPick(value)
        }}
      />
      <text fg={COLORS.dim}>{parsed.freeform ? "↑/↓ move · ⏎ select · Tab → type" : "↑/↓ move · ⏎ select"}</text>
    </box>
  )
}
