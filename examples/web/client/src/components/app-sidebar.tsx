// Thread list (persisted via the harness's Mastra memory). Thread ids are full
// 21-char nanoids — truncate only visually (CSS), never the value.
import { useHarnessClient, type HarnessState } from "@super-harness/react"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { PlusIcon, Trash2Icon } from "lucide-react"

export function AppSidebar({ state }: { state: HarnessState }) {
  const harness = useHarnessClient()
  const threads = [...state.threads].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))

  return (
    <Sidebar>
      <SidebarHeader className="flex-row items-center justify-between">
        <span className="px-2 font-semibold text-sm">super-harness</span>
        <Button variant="ghost" size="icon" title="New thread" onClick={() => void harness.newThread()}>
          <PlusIcon className="size-4" />
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Threads</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {threads.length === 0 && (
                <div className="px-2 py-1 text-muted-foreground text-xs">none yet — say something</div>
              )}
              {threads.map((t) => (
                <SidebarMenuItem key={t.id}>
                  <SidebarMenuButton
                    isActive={t.id === state.threadId}
                    onClick={() => void harness.switchThread(t.id)}
                    title={t.id}
                  >
                    <span className="truncate">{t.title || t.id}</span>
                  </SidebarMenuButton>
                  <SidebarMenuAction showOnHover title="Delete thread" onClick={() => void harness.deleteThread(t.id)}>
                    <Trash2Icon />
                  </SidebarMenuAction>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
