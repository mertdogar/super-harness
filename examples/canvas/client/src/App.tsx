// Two panes over one socket: the shared canvas (boards lobby + the active
// board's CRDT scene doc) on the left, the harness chat on the right — the
// same composition as plan-board's chat panel, but every sent message is
// prefixed with "[board:<id>] " so the supervisor knows which scene to edit.
// The clear_board approval gate lands in the shared ApprovalDialog.
import { useState } from "react"
import { useHarness, useHarnessClient, type PendingAsk } from "@super-harness/react"
import type { TokenUsage } from "@super-harness/shared"
import { MessageCircleQuestionIcon, XIcon } from "lucide-react"
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { NodeView } from "@/components/node-view"
import { ApprovalDialog } from "@/components/approval-dialog"
import { BoardsLobby } from "@/components/boards-lobby"
import { BoardCanvas } from "@/components/board-canvas"
import { useDoc } from "@/hooks/use-doc"
import { DEFAULT_BOARD_ID } from "../../shared/scene"
import type { CanvasClient } from "@/lib/client"

export default function App({
  sl,
  nodes,
  node,
  onNodeChange,
}: {
  sl: CanvasClient
  nodes: number[]
  node: number
  onNodeChange: (n: number) => void
}) {
  const state = useHarness()
  const harness = useHarnessClient()
  const { tree, connected, busy, pendingAsk, pendingApproval, notice, queued } = state
  const [activeBoardId, setActiveBoardId] = useState(DEFAULT_BOARD_ID)
  const doc = useDoc(sl, activeBoardId)

  const onSubmit = async (message: PromptInputMessage) => {
    const text = message.text?.trim()
    if (!text) return
    if (pendingAsk) await harness.reply(text)
    else await harness.send(`[board:${activeBoardId}] ${text}`)
  }

  return (
    <div className="flex h-svh flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <h1 className="font-semibold text-lg">super-harness · canvas</h1>
        <div className="ml-auto flex items-center gap-2">
          <UsageBadge usage={tree.usage} />
          <Badge variant={connected ? "default" : "outline"}>{connected ? "connected" : "offline"}</Badge>
          {nodes.length > 1 && (
            <Select value={String(node)} onValueChange={(v) => onNodeChange(Number(v))}>
              <SelectTrigger size="sm" className="w-24">
                <SelectValue placeholder="node" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    node-{n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[440px] shrink-0 flex-col gap-4 overflow-y-auto border-r p-4">
          <BoardsLobby sl={sl} activeBoardId={activeBoardId} onSelect={setActiveBoardId} />
          <BoardCanvas doc={doc} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <section className="flex flex-col gap-2">
            {pendingAsk && <AskBanner ask={pendingAsk} onDismiss={() => harness.dismissAsk()} />}
            {queued > 0 && (
              <p className="text-muted-foreground text-xs">
                {queued} follow-up{queued > 1 ? "s" : ""} queued
              </p>
            )}
            {notice && <p className="text-destructive text-xs">{notice}</p>}
            <PromptInput onSubmit={onSubmit}>
              <PromptInputTextarea
                autoFocus
                placeholder={
                  pendingAsk ? "Reply to the agent…" : 'Ask the agent — e.g. "add three blue squares in a row"'
                }
              />
              <div className="flex items-center justify-end gap-2 p-2">
                <PromptInputSubmit
                  status={busy ? "streaming" : undefined}
                  onClick={busy ? (e) => { e.preventDefault(); void harness.abort() } : undefined}
                />
              </div>
            </PromptInput>
          </section>

          <section className="flex min-w-0 flex-col gap-3">
            <h2 className="text-muted-foreground text-xs uppercase tracking-wide">Conversation</h2>
            {tree.turns.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Ask the agent to edit the board — its shapes land live, next to yours.
              </p>
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
        </div>
      </div>

      <ApprovalDialog pending={pendingApproval} />
    </div>
  )
}

// Cumulative token total for the conversation (tree.usage), with a full
// breakdown on hover. Hidden until the first turn reports usage.
function UsageBadge({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage || !usage.totalTokens) return null
  const title = `input ${usage.inputTokens ?? 0} · output ${usage.outputTokens ?? 0} · cached ${usage.cachedInputTokens ?? 0} · reasoning ${usage.reasoningTokens ?? 0}`
  return (
    <Badge variant="outline" className="font-mono" title={title}>
      {fmtTokens(usage.totalTokens)} tok
    </Badge>
  )
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function AskBanner({ ask, onDismiss }: { ask: PendingAsk; onDismiss: () => void }) {
  const question =
    ask.request && typeof ask.request === "object" && "question" in ask.request
      ? String((ask.request as { question: unknown }).question)
      : "The agent needs your input."
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
