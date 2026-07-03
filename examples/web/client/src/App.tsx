import { useHarness, useHarnessClient } from "@super-harness/react"
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
