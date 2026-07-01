// Renders one turn's node tree as an OpenTUI tree. Per node: reasoning (dim) →
// tools and subagent lanes interleaved in call order (textOffset slicing) →
// trailing text → interrupted-run banner. Subagent lanes are always expanded
// (bordered + indented); tools render as compact status cards. Reads the assembled
// ClientTree from the Store (subscribeTree) — no client-side reduce.

import type { ReactNode } from "react"
import type { ClientTree, NodeState, ToolState } from "@super-harness/shared"
import { COLORS, agentGlyph, nodeColor, toolColor, toolGlyph, toolLabel, tokens } from "./theme"

const BODY_LIMIT = 800

function childrenOf(tree: ClientTree, nodeId: string): NodeState[] {
  const node = tree.nodes[nodeId]
  if (!node) return []
  return node.childOrder.map((cid) => tree.nodes[cid]).filter((n): n is NodeState => Boolean(n))
}

function pretty(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncate(text: string, full: boolean): string {
  if (full || text.length <= BODY_LIMIT) return text
  return `${text.slice(0, BODY_LIMIT)}\n…[+${text.length - BODY_LIMIT} chars]`
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null
  const v = (value as Record<string, unknown>)[key]
  return typeof v === "string" ? v : null
}

function imagePathOf(result: unknown): string | null {
  const fp = stringField(result, "filePath")
  return fp && /\.(png|jpe?g|webp|gif)$/i.test(fp) ? fp : null
}

function Body({ text }: { text: string }) {
  return (
    <box flexDirection="column" paddingLeft={1} border={["left"]} borderColor={COLORS.border}>
      <text fg={COLORS.dim}>{text}</text>
    </box>
  )
}

function ToolRow({ tool, full }: { tool: ToolState; full: boolean }) {
  const desc = stringField(tool.args, "description")
  const script = tool.toolName === "execute_script" ? stringField(tool.args, "script") : null
  const imagePath = imagePathOf(tool.result)
  const argsText = script || tool.args == null ? "" : truncate(pretty(tool.args), full)
  const resultText = imagePath || tool.result == null ? "" : truncate(pretty(tool.result), full)
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={toolColor(tool.status)}>{`${toolGlyph(tool.status)} ${toolLabel(tool.toolName)}`}</text>
        {desc ? <text fg={COLORS.dim}>{`  ${desc}`}</text> : null}
      </box>
      {script ? <Body text={truncate(script, full)} /> : null}
      {argsText ? <Body text={argsText} /> : null}
      {imagePath ? (
        <box paddingLeft={2}>
          <text fg={COLORS.cyan}>{`image → ${imagePath}`}</text>
        </box>
      ) : null}
      {resultText ? (
        <box paddingLeft={1} border={["left"]} borderColor={COLORS.border}>
          <text fg={tool.isError ? COLORS.red : COLORS.dim}>{resultText}</text>
        </box>
      ) : null}
    </box>
  )
}

// ask_user is answered through the docked prompt, so inline it's just a status row.
function QuestionRow({ tool }: { tool: ToolState }) {
  const answered = tool.status === "output-available" || tool.status === "error"
  return (
    <text fg={answered ? COLORS.green : COLORS.yellow}>
      {answered ? "✓ Asked you a question" : "? Waiting for your answer…"}
    </text>
  )
}

function ToolCard({ tool, full }: { tool: ToolState | undefined; full: boolean }) {
  if (!tool) return null
  if (tool.toolName === "ask_user") return <QuestionRow tool={tool} />
  return <ToolRow tool={tool} full={full} />
}

function laneMeta(node: NodeState): string {
  const parts: string[] = []
  if (node.toolOrder.length > 0) parts.push(`${node.toolOrder.length} step${node.toolOrder.length === 1 ? "" : "s"}`)
  if (node.usage?.totalTokens) parts.push(tokens(node.usage.totalTokens))
  if (node.durationMs) parts.push(`${(node.durationMs / 1000).toFixed(1)}s`)
  return parts.join(" · ")
}

interface LaneProps {
  tree: ClientTree
  node: NodeState
  live: boolean
  full: boolean
}

// A delegated subagent run — bordered, always expanded, recurses into NodeView.
function Lane({ tree, node, live, full }: LaneProps) {
  const header = `${agentGlyph(node.agentType)} ${node.agentType ?? "subagent"}${node.task ? `: ${node.task}` : ""}`
  const meta = laneMeta(node)
  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={COLORS.border} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={nodeColor(node.status)}>{header}</text>
        {meta ? <text fg={COLORS.dim}>{`  ${meta}`}</text> : null}
      </box>
      <NodeView tree={tree} node={node} live={live} full={full} />
    </box>
  )
}

export function NodeView({ tree, node, live, full }: LaneProps) {
  const children = childrenOf(tree, node.nodeId)
  const childByNode = new Map(children.map((c) => [c.nodeId, c]))
  const inToolOrder = new Set(node.toolOrder)

  const slots: { offset: number; element: ReactNode }[] = []
  for (const toolCallId of node.toolOrder) {
    const child = childByNode.get(toolCallId)
    const offset = node.tools[toolCallId]?.textOffset ?? child?.textOffset ?? node.text.length
    slots.push({
      offset,
      element: child ? (
        <Lane key={toolCallId} tree={tree} node={child} live={live} full={full} />
      ) : (
        <ToolCard key={toolCallId} tool={node.tools[toolCallId]} full={full} />
      ),
    })
  }
  for (const child of children) {
    if (inToolOrder.has(child.nodeId)) continue
    slots.push({
      offset: child.textOffset ?? node.text.length,
      element: <Lane key={child.nodeId} tree={tree} node={child} live={live} full={full} />,
    })
  }
  slots.sort((a, b) => a.offset - b.offset)

  const body: ReactNode[] = []
  let cursor = 0
  for (const slot of slots) {
    const offset = Math.min(slot.offset, node.text.length)
    const slice = node.text.slice(cursor, offset)
    if (slice.trim()) body.push(<text key={`text-${cursor}`} fg={COLORS.text}>{slice}</text>)
    cursor = Math.max(cursor, offset)
    body.push(slot.element)
  }
  const tail = node.text.slice(cursor)
  if (tail.trim()) body.push(<text key="text-tail" fg={COLORS.text}>{tail}</text>)

  return (
    <box flexDirection="column">
      {node.reasoning.trim() ? <text fg={COLORS.dim}>{`think  ${node.reasoning.trim()}`}</text> : null}
      {body}
      {node.error ? (
        <box border borderStyle="rounded" borderColor={COLORS.red} paddingLeft={1} paddingRight={1}>
          <text fg={COLORS.red}>{`Run interrupted — ${node.error}`}</text>
        </box>
      ) : null}
    </box>
  )
}

// The whole turn: a "Plan" box (todos) + the root node tree.
export function TurnView({
  tree,
  root,
  live,
  full,
}: {
  tree: ClientTree
  root: NodeState
  live: boolean
  full: boolean
}) {
  const todos = tree.todos
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={COLORS.purple}>◇ Super Harness</text>
      {todos && todos.length > 0 ? (
        <box flexDirection="column" border borderStyle="rounded" borderColor={COLORS.border} paddingLeft={1} paddingRight={1}>
          <text fg={COLORS.dim}>Plan</text>
          {todos.map((todo) => (
            <text key={todo.content} fg={todo.status === "completed" ? COLORS.dim : COLORS.text}>
              {`${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "~" : " "} ${todo.content}`}
            </text>
          ))}
        </box>
      ) : null}
      <NodeView tree={tree} node={root} live={live} full={full} />
    </box>
  )
}
