import { useHarness, useHarnessClient } from "@super-harness/react"
import type { TokenUsage } from "@super-harness/shared"
import { AppSidebar } from "@/components/app-sidebar"
import { ApprovalDialog } from "@/components/approval-dialog"
import { Chat } from "@/components/chat"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"

export default function App({
  nodes,
  node,
  onNodeChange,
}: {
  nodes: number[]
  node: number
  onNodeChange: (n: number) => void
}) {
  const state = useHarness()
  const client = useHarnessClient()
  const activeThread = state.threads.find((t) => t.id === state.threadId)
  // No "get thread mode" read on the contract: show the default until a live
  // modeChanged (or our own switch) corrects it.
  const modeId = state.modeId ?? state.defaultModeId

  return (
    <SidebarProvider>
      <AppSidebar state={state} />
      <SidebarInset className="flex h-svh flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <SidebarTrigger />
          <span className="truncate font-mono text-muted-foreground text-xs" title={state.threadId}>
            {activeThread?.title || state.threadId}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <UsageBadge usage={state.tree.usage} />
            <Badge variant={state.connected ? "secondary" : "destructive"}>
              {state.connected ? "connected" : "offline"}
            </Badge>
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
            {state.modes.length > 0 && (
              <Select value={modeId} onValueChange={(v) => void client.setMode(v)}>
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue placeholder="mode" />
                </SelectTrigger>
                <SelectContent>
                  {state.modes.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name ?? m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </header>
        <Chat state={state} />
        <ApprovalDialog pending={state.pendingApproval} />
      </SidebarInset>
    </SidebarProvider>
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
