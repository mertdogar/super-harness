// Two panes over one socket: the shared canvas (boards lobby + the active
// board's CRDT scene doc) on the left, the harness chat on the right — the
// same composition as plan-board's chat panel, but every sent message is
// prefixed with "[board:<id>] " so the supervisor knows which scene to edit.
// The clear_board approval gate lands in the shared ApprovalDialog. Image
// attachments ride harness.send(text, files) — the agent sees them inline and
// list_attachments enumerates them server-side; chips here are LIVE-ONLY
// (attachments aren't persisted in the tree — a reload shows just the text).
import { useEffect, useRef, useState } from "react"
import { useHarness, useHarnessClient, type PendingAsk } from "@super-harness/react"
import type { FileAttachment, TokenUsage } from "@super-harness/shared"
import { MessageCircleQuestionIcon, PaperclipIcon, XIcon } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { NodeView } from "@/components/node-view"
import { ApprovalDialog } from "@/components/approval-dialog"
import { BoardsLobby } from "@/components/boards-lobby"
import { BoardCanvas } from "@/components/board-canvas"
import { useDoc } from "@/hooks/use-doc"
import { DEFAULT_BOARD_ID } from "../../shared/scene"
import { boardThreadId, type CanvasClient } from "@/lib/client"

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
    <PromptInputButton onClick={() => attachments.openFileDialog()} aria-label="Attach images">
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  )
}

// Live-only chips: attachments aren't persisted in the tree, so remember what
// this session sent and pin each to the next unmatched root turn whose task
// equals the sent (board-prefixed) text. A reload renders just the text.
//
// The assignment (p.turnId = id) is an idempotent ref mutation done in the
// effect body, NOT inside the setState updater — an impure updater would be
// double-run by StrictMode and drop the match. `byTurn` is derived purely.
function useSentAttachments(tree: ReturnType<typeof useHarness>["tree"]) {
  const pending = useRef<{ text: string; files: FileAttachment[]; before: Set<string>; turnId?: string }[]>([])
  const turnsRef = useRef(tree.turns)
  turnsRef.current = tree.turns
  const [byTurn, setByTurn] = useState<Record<string, FileAttachment[]>>({})
  useEffect(() => {
    const taken = new Set(Object.keys(byTurn))
    let next: Record<string, FileAttachment[]> | undefined
    for (const id of tree.turns) {
      if (taken.has(id)) continue
      // Match a send to a turn that appeared AFTER it (p.before excludes the
      // turns already present when we sent), and normalize task to "" (core
      // stores it as `input || undefined`; the board prefix keeps it non-empty
      // today, but this stays correct if that ever changes).
      const p = pending.current.find(
        (p) => !p.turnId && !p.before.has(id) && (tree.nodes[id]?.task ?? "") === p.text,
      )
      if (!p) continue
      p.turnId = id
      taken.add(id)
      next = { ...(next ?? byTurn), [id]: p.files }
    }
    if (next) setByTurn(next)
  }, [tree, byTurn])
  return {
    byTurn,
    remember: (text: string, files: FileAttachment[]) =>
      pending.current.push({ text, files, before: new Set(turnsRef.current) }),
  }
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
  // Point the conversation at the active board's thread. Both tabs derive the
  // same id, so the stream is shared and live across tabs (like the canvas).
  // switchThread is idempotent, so the initial default-board render is a no-op;
  // the harness dep re-points after a node swap (the client is a fresh one).
  useEffect(() => {
    void harness.switchThread(boardThreadId(activeBoardId))
  }, [activeBoardId, harness])
  const sent = useSentAttachments(tree)
  // Attachment rejections (too big / wrong type) are otherwise silent.
  const [fileError, setFileError] = useState<string | null>(null)

  const onSubmit = async (message: PromptInputMessage) => {
    setFileError(null)
    const text = message.text?.trim() ?? ""
    const files = toWireFiles(message.files ?? [])
    if (!text && !files.length) return
    if (pendingAsk) {
      await harness.reply(text)
      return
    }
    const prefixed = `[board:${activeBoardId}] ${text}`
    if (files.length) sent.remember(prefixed, files)
    await harness.send(prefixed, files.length ? files : undefined)
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
            {fileError && <p className="text-destructive text-xs">{fileError}</p>}
            <PromptInput
              onSubmit={onSubmit}
              onError={(err) => setFileError(err.message)}
              accept="image/*"
              multiple
              maxFileSize={5 * 1024 * 1024}
            >
              <PromptInputAttachments>{(file) => <PromptInputAttachment data={file} />}</PromptInputAttachments>
              <PromptInputTextarea
                autoFocus
                placeholder={
                  pendingAsk ? "Reply to the agent…" : 'Ask the agent — e.g. "add three blue squares in a row"'
                }
              />
              {/* PromptInputFooter is the block-end addon that flips the InputGroup
                  to column layout — a plain div here collapses the textarea. */}
              <PromptInputFooter>
                <AttachButton />
                <PromptInputSubmit
                  status={busy ? "streaming" : undefined}
                  onClick={busy ? (e) => { e.preventDefault(); void harness.abort() } : undefined}
                />
              </PromptInputFooter>
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
                const chips = sent.byTurn[id]
                return (
                  <div key={id} className="flex flex-col gap-3">
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
