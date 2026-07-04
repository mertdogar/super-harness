// The plan board, on the same shadcn/ai-elements stack as examples/web — but a
// plan-first layout, not a chat: a goal composer, the live PLAN checklist
// (tree.todos), then the EXECUTION stream (recursive NodeView per turn). ask_user
// reuses the composer as a reply box; tool approval opens the shared dialog.
import { useHarness, useHarnessClient, type PendingAsk } from "@super-harness/react"
import type { TodoItem } from "@super-harness/shared"
import { CircleIcon, CircleCheckBigIcon, LoaderIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react"
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { NodeView } from "@/components/node-view"
import { ApprovalDialog } from "@/components/approval-dialog"
import { cn } from "@/lib/utils"

const DEFAULT_GOAL = "Plan a 3-day Rome trip"

export default function App() {
  const state = useHarness()
  const harness = useHarnessClient()
  const { tree, connected, busy, pendingAsk, pendingApproval, notice, queued } = state

  const onSubmit = async (message: PromptInputMessage) => {
    const text = message.text?.trim()
    if (!text) return
    if (pendingAsk) await harness.reply(text)
    else await harness.send(text)
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex items-center gap-2">
        <h1 className="font-semibold text-lg">super-harness · plan board</h1>
        <Badge variant={connected ? "default" : "outline"} className="ml-auto">
          {connected ? "connected" : "offline"}
        </Badge>
      </header>

      <section className="flex flex-col gap-2">
        {pendingAsk && <AskBanner ask={pendingAsk} onDismiss={() => harness.dismissAsk()} />}
        {queued > 0 && <p className="text-muted-foreground text-xs">{queued} follow-up{queued > 1 ? "s" : ""} queued</p>}
        {notice && <p className="text-destructive text-xs">{notice}</p>}
        <PromptInput onSubmit={onSubmit}>
          <PromptInputTextarea
            autoFocus
            defaultValue={DEFAULT_GOAL}
            placeholder={pendingAsk ? "Reply to the planner…" : "Give the planner a goal…"}
          />
          <div className="flex items-center justify-end gap-2 p-2">
            <PromptInputSubmit
              status={busy ? "streaming" : undefined}
              onClick={busy ? (e) => { e.preventDefault(); void harness.abort() } : undefined}
            />
          </div>
        </PromptInput>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Plan</CardTitle>
        </CardHeader>
        <CardContent>
          <Plan todos={tree.todos} busy={busy} />
        </CardContent>
      </Card>

      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-muted-foreground text-xs uppercase tracking-wide">Execution</h2>
        {tree.turns.length === 0 ? (
          <p className="text-muted-foreground text-sm">Give the planner a goal to watch it plan and execute.</p>
        ) : (
          tree.turns.map((id) => {
            const root = tree.nodes[id]
            return (
              <div key={id} className="flex flex-col gap-3">
                {root?.task && (
                  <Message from="user">
                    <MessageContent>{root.task}</MessageContent>
                  </Message>
                )}
                <Message from="assistant">
                  <MessageContent className="w-full">
                    <NodeView tree={tree} nodeId={id} approvalToolCallId={pendingApproval?.toolCallId} />
                  </MessageContent>
                </Message>
              </div>
            )
          })
        )}
      </section>

      <ApprovalDialog pending={pendingApproval} />
    </div>
  )
}

function Plan({ todos, busy }: { todos: TodoItem[] | undefined; busy: boolean }) {
  const items = todos ?? []
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">{busy ? "drafting a plan…" : "No plan yet."}</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((t, i) => (
        <li key={`${i}-${t.content}`} className="flex items-start gap-2 text-sm">
          <TodoIcon status={t.status} />
          <span className={cn(t.status === "completed" && "text-muted-foreground line-through")}>{t.content}</span>
        </li>
      ))}
    </ul>
  )
}

function TodoIcon({ status }: { status: TodoItem["status"] }) {
  if (status === "completed") return <CircleCheckBigIcon className="mt-0.5 size-4 shrink-0 text-green-600" />
  if (status === "in_progress") return <LoaderIcon className="mt-0.5 size-4 shrink-0 animate-spin text-amber-500" />
  return <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
}

function AskBanner({ ask, onDismiss }: { ask: PendingAsk; onDismiss: () => void }) {
  const question =
    ask.request && typeof ask.request === "object" && "question" in ask.request
      ? String((ask.request as { question: unknown }).question)
      : "The planner needs your input."
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/50 p-3 text-sm">
      <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1">{question}</span>
      <button type="button" className="text-muted-foreground hover:text-foreground" title="Dismiss" onClick={onDismiss}>
        <XIcon className="size-4" />
      </button>
    </div>
  )
}
