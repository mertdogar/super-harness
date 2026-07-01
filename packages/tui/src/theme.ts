// Shared glyphs + palette for the TUI tree renderer. ASCII/box-drawing only (no
// wide emoji) so OpenTUI's column math and any copy-paste stay aligned.

import type { NodeStatus, ToolStatus } from "@super-harness/shared"

export const COLORS = {
  dim: "#6b7280",
  text: "#d4d4d4",
  accent: "#61afef",
  green: "#98c379",
  red: "#e06c75",
  yellow: "#e5c07b",
  purple: "#c678dd",
  cyan: "#56b6c2",
  border: "#3a3f4b",
  userBorder: "#3b6ea5",
}

export function toolGlyph(status: ToolStatus): string {
  if (status === "error") return "✗"
  if (status === "output-available") return "✓"
  if (status === "input-streaming") return "·"
  return "▸"
}

export function toolColor(status: ToolStatus): string {
  if (status === "error") return COLORS.red
  if (status === "output-available") return COLORS.green
  return COLORS.yellow
}

export function nodeColor(status: NodeStatus): string {
  if (status === "error" || status === "aborted") return COLORS.red
  if (status === "complete") return COLORS.green
  return COLORS.yellow
}

export function agentGlyph(agentType: string | undefined): string {
  if (agentType === "reviewer") return "◇"
  if (agentType === "researcher" || agentType === "research") return "✦"
  if (agentType === "browser-use") return "◈"
  return "◆"
}

export function toolLabel(name: string): string {
  return name.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase())
}

export function tokens(total: number): string {
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`
}
