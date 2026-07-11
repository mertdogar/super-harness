// Recursive renderer for one harness node: reasoning, then text and tool calls
// interleaved chronologically (ToolState.textOffset marks where in the text each
// call happened). A `delegate` call whose toolCallId matches a child node id
// renders that child's ENTIRE stream nested inside a collapsible Task — the
// full-fidelity subagent view, recursive down to maxDepth.
import type { ClientTree, NodeState, ToolState } from "@super-harness/shared"
import { MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task"
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool"
import { Loader } from "@/components/ai-elements/loader"
import { Badge } from "@/components/ui/badge"

type ToolUIState = Parameters<typeof ToolHeader>[0]["state"]

function toolState(t: ToolState, approvalToolCallId?: string): ToolUIState {
  if (t.toolCallId === approvalToolCallId) return "approval-requested"
  if (t.status === "error") return "output-error"
  return t.status
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolState }
  | { kind: "child"; child: NodeState }

// Core suppresses the `delegate` tool's own events — a delegation shows up as a
// CHILD NODE (childOrder), not a ToolState. Interleave text, visible tool calls,
// and children chronologically via their textOffsets into the parent's text.
function segments(node: NodeState, tree: ClientTree): Segment[] {
  // Children pushed first: at an equal offset (no text between the calls) a
  // delegation almost always precedes the sibling tool call, and the stable
  // sort preserves push order on ties.
  const marks: Array<{ offset: number; seg: Segment }> = []
  for (const id of node.childOrder) {
    const child = tree.nodes[id]
    if (child) marks.push({ offset: child.textOffset ?? node.text.length, seg: { kind: "child", child } })
  }
  for (const id of node.toolOrder) {
    const t = node.tools[id]
    marks.push({ offset: t.textOffset ?? node.text.length, seg: { kind: "tool", tool: t } })
  }
  marks.sort((a, b) => a.offset - b.offset)

  const out: Segment[] = []
  let cursor = 0
  for (const m of marks) {
    const offset = Math.min(Math.max(m.offset, cursor), node.text.length)
    if (offset > cursor) {
      out.push({ kind: "text", text: node.text.slice(cursor, offset) })
      cursor = offset
    }
    out.push(m.seg)
  }
  if (cursor < node.text.length) out.push({ kind: "text", text: node.text.slice(cursor) })
  return out
}

export function NodeView({
  tree,
  nodeId,
  approvalToolCallId,
}: {
  tree: ClientTree
  nodeId: string
  approvalToolCallId?: string
}) {
  const node = tree.nodes[nodeId]
  if (!node) return null
  const running = node.status === "running"
  const parts = segments(node, tree)

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {node.reasoning && (
        <Reasoning defaultOpen={false} isStreaming={running && parts.length === 0}>
          <ReasoningTrigger />
          <ReasoningContent>{node.reasoning}</ReasoningContent>
        </Reasoning>
      )}

      {parts.map((part, i) => {
        if (part.kind === "text") return <MessageResponse key={`text-${i}`}>{part.text}</MessageResponse>
        if (part.kind === "child") {
          return (
            <ChildView key={part.child.nodeId} tree={tree} child={part.child} approvalToolCallId={approvalToolCallId} />
          )
        }
        return <ToolView key={part.tool.toolCallId} tool={part.tool} approvalToolCallId={approvalToolCallId} />
      })}

      {running && parts.length === 0 && !node.reasoning && <Loader />}
      {node.error && <div className="text-destructive text-sm">{node.error}</div>}
      {node.status === "aborted" && (
        <Badge variant="outline" className="w-fit">
          aborted
        </Badge>
      )}
    </div>
  )
}

// A delegation, rendered as the child's ENTIRE stream nested in a collapsible.
function ChildView({
  tree,
  child,
  approvalToolCallId,
}: {
  tree: ClientTree
  child: NodeState
  approvalToolCallId?: string
}) {
  return (
    <Task defaultOpen={child.status === "running"} className="w-full">
      <TaskTrigger title={`${child.agentType ?? "subagent"}${child.task ? ` — ${child.task}` : ""}`} />
      <TaskContent>
        {/* TaskContent already draws the left rail — no extra wrapper */}
        <NodeView tree={tree} nodeId={child.nodeId} approvalToolCallId={approvalToolCallId} />
      </TaskContent>
    </Task>
  )
}

function ToolView({ tool, approvalToolCallId }: { tool: ToolState; approvalToolCallId?: string }) {
  return (
    <Tool defaultOpen={tool.toolCallId === approvalToolCallId}>
      <ToolHeader type={`tool-${tool.toolName || "call"}`} state={toolState(tool, approvalToolCallId)} />
      <ToolContent>
        {tool.args !== undefined && <ToolInput input={tool.args} />}
        <ToolOutput
          output={tool.isError ? undefined : (tool.result as Parameters<typeof ToolOutput>[0]["output"])}
          errorText={tool.isError ? String(tool.result ?? "tool failed") : undefined}
        />
      </ToolContent>
    </Tool>
  )
}
