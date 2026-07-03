// The conversation pane: turns from the tree (user bubble = root node's task,
// assistant body = recursive NodeView), plus the composer. When an ask_user
// suspension is pending the SAME composer becomes the reply box.
import { useHarnessClient, type HarnessState } from "@super-harness/react"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { NodeView } from "@/components/node-view"
import { MessageCircleQuestionIcon, XIcon } from "lucide-react"

function askQuestion(request: unknown): string {
  if (typeof request === "string") return request
  if (request && typeof request === "object" && "question" in request) {
    return String((request as { question: unknown }).question)
  }
  return JSON.stringify(request)
}

export function Chat({ state }: { state: HarnessState }) {
  const harness = useHarnessClient()
  const { tree, busy, pendingAsk, pendingApproval, queued, notice } = state

  const onSubmit = async (message: PromptInputMessage) => {
    const text = message.text?.trim()
    if (!text) return
    if (pendingAsk) await harness.reply(text)
    else await harness.send(text)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {tree.turns.length === 0 && (
            <ConversationEmptyState
              title="super-harness"
              description="Ask about the weather (the supervisor delegates to a worker) or ask it to email you a report (approval-gated)."
            />
          )}
          {tree.turns.map((id) => {
            const root = tree.nodes[id]
            return (
              <div key={id} className="flex flex-col gap-4">
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
          })}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {pendingAsk && (
          <div className="mb-2 flex items-start gap-2 rounded-md border bg-muted/50 p-3 text-sm">
            <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">{askQuestion(pendingAsk.request)}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title="Dismiss"
              onClick={() => harness.dismissAsk()}
            >
              <XIcon className="size-4" />
            </button>
          </div>
        )}
        {queued > 0 && <div className="mb-2 text-muted-foreground text-xs">{queued} follow-up(s) queued</div>}
        {notice && <div className="mb-2 text-destructive text-xs">{notice}</div>}
        <PromptInput onSubmit={onSubmit}>
          <PromptInputTextarea
            autoFocus
            placeholder={pendingAsk ? "Reply to the agent…" : "Say something…"}
          />
          <div className="flex items-center justify-end gap-2 p-2">
            {/* While busy the square icon is a real Stop (Enter still queues a
                follow-up); preventDefault stops the click from submitting. */}
            <PromptInputSubmit
              status={busy ? "streaming" : undefined}
              onClick={busy
                ? (e) => {
                    e.preventDefault()
                    void harness.abort()
                  }
                : undefined}
            />
          </div>
        </PromptInput>
      </div>
    </div>
  )
}
