// The conversation pane: turns from the tree (user bubble = root node's task,
// assistant body = recursive NodeView), plus the composer. When an ask_user
// suspension is pending the SAME composer becomes the reply box. File
// attachments ride harness.send(text, files) — the PromptInput already
// converts picked files to data URLs on submit — and render as LIVE-ONLY
// chips (attachments aren't persisted in the tree; a reload shows just text).
import { useEffect, useRef, useState } from "react"
import { useHarnessClient, type HarnessState } from "@super-harness/react"
import type { FileAttachment } from "@super-harness/shared"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { NodeView } from "@/components/node-view"
import { MessageCircleQuestionIcon, PaperclipIcon, XIcon } from "lucide-react"

function askQuestion(request: unknown): string {
  if (typeof request === "string") return request
  if (request && typeof request === "object" && "question" in request) {
    return String((request as { question: unknown }).question)
  }
  return JSON.stringify(request)
}

// The PromptInput's files are FileUIPart with data URLs (converted on submit).
function toWireFiles(files: PromptInputMessage["files"]): FileAttachment[] {
  return files
    .filter((f) => f.url?.startsWith("data:"))
    .map((f) => ({ url: f.url, mimeType: f.mediaType, name: f.filename }))
}

// Paperclip in the composer footer — must live inside PromptInput's context.
function AttachButton() {
  const attachments = usePromptInputAttachments()
  return (
    <PromptInputButton onClick={() => attachments.openFileDialog()} aria-label="Attach files">
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  )
}

// Live-only chips: attachments aren't persisted in the tree, so remember what
// this session sent and pin each to the next unmatched root turn whose task
// equals the sent text. A reload renders just the text.
//
// The assignment (p.turnId = id) is an idempotent ref mutation done in the
// effect body, NOT inside the setState updater — an impure updater would be
// double-run by StrictMode and drop the match. `byTurn` is derived purely.
function useSentAttachments(tree: HarnessState["tree"]) {
  const pending = useRef<{ text: string; files: FileAttachment[]; turnId?: string }[]>([])
  const [byTurn, setByTurn] = useState<Record<string, FileAttachment[]>>({})
  useEffect(() => {
    const taken = new Set(Object.keys(byTurn))
    let next: Record<string, FileAttachment[]> | undefined
    for (const id of tree.turns) {
      if (taken.has(id)) continue
      const p = pending.current.find((p) => !p.turnId && tree.nodes[id]?.task === p.text)
      if (!p) continue
      p.turnId = id
      taken.add(id)
      next = { ...(next ?? byTurn), [id]: p.files }
    }
    if (next) setByTurn(next)
  }, [tree, byTurn])
  return { byTurn, remember: (text: string, files: FileAttachment[]) => pending.current.push({ text, files }) }
}

function AttachmentChips({ files }: { files: FileAttachment[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {files.map((f, i) =>
        f.mimeType?.startsWith("image/") || !f.mimeType ? (
          <img
            key={i}
            src={f.url}
            alt={f.name ?? "attachment"}
            title={f.name}
            className="h-16 w-16 rounded-md border object-cover"
          />
        ) : (
          <span key={i} className="rounded-md border bg-muted px-2 py-1 text-muted-foreground text-xs">
            {f.name ?? f.mimeType}
          </span>
        ),
      )}
    </div>
  )
}

export function Chat({ state }: { state: HarnessState }) {
  const harness = useHarnessClient()
  const { tree, busy, pendingAsk, pendingApproval, queued, notice, activeThreadDeleted } = state
  const sent = useSentAttachments(tree)

  const onSubmit = async (message: PromptInputMessage) => {
    const text = message.text?.trim() ?? ""
    const files = toWireFiles(message.files ?? [])
    if (!text && !files.length) return
    if (pendingAsk) {
      await harness.reply(text)
      return
    }
    if (files.length) sent.remember(text, files)
    await harness.send(text, files.length ? files : undefined)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl">
          {tree.turns.length === 0 &&
            (activeThreadDeleted ? (
              <ConversationEmptyState
                title="Thread deleted"
                description="This conversation was deleted from another tab. Start a new thread or pick one from the sidebar."
              />
            ) : (
              <ConversationEmptyState
                title="super-harness"
                description="Ask about the weather (the supervisor delegates to a worker) or ask it to email you a report (approval-gated)."
              />
            ))}
          {tree.turns.map((id) => {
            const root = tree.nodes[id]
            const chips = sent.byTurn[id]
            return (
              <div key={id} className="flex flex-col gap-4">
                {(root?.task || chips) && (
                  <Message from="user">
                    <div className="flex flex-col items-end gap-1.5">
                      {chips && <AttachmentChips files={chips} />}
                      {root?.task && <MessageContent>{root.task}</MessageContent>}
                    </div>
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
        {/* Active thread deleted elsewhere: the composer would post to a dead
            thread, so gate it behind an explicit new-thread action. */}
        {activeThreadDeleted ? (
          <button
            type="button"
            className="w-full rounded-md border bg-muted/50 py-3 text-sm hover:bg-muted"
            onClick={() => void harness.newThread()}
          >
            Start a new thread
          </button>
        ) : (
          <PromptInput
            onSubmit={onSubmit}
            accept="image/*,application/pdf,text/*"
            multiple
            maxFileSize={5 * 1024 * 1024}
          >
            <PromptInputAttachments>{(file) => <PromptInputAttachment data={file} />}</PromptInputAttachments>
            <PromptInputTextarea
              autoFocus
              placeholder={pendingAsk ? "Reply to the agent…" : "Say something — attach a file if you like…"}
            />
            {/* PromptInputFooter is the block-end addon that flips the InputGroup
                to column layout — a plain div here collapses the textarea. */}
            <PromptInputFooter>
              <AttachButton />
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
            </PromptInputFooter>
          </PromptInput>
        )}
      </div>
    </div>
  )
}
