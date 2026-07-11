// HITL approval: approvalRequired room event → dialog → respondToApproval.
// always_allow becomes a per-thread session grant server-side.
import { useHarnessClient, type PendingApproval } from "@super-harness/react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function ApprovalDialog({ pending }: { pending: PendingApproval | null }) {
  const harness = useHarnessClient()
  return (
    <Dialog open={pending !== null}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Allow <code className="font-mono">{pending?.toolName}</code>?
          </DialogTitle>
          <DialogDescription>The supervisor wants to run a gated tool with these arguments:</DialogDescription>
        </DialogHeader>
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(pending?.args, null, 2)}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={() => void harness.respond("decline", "declined by operator")}>
            Decline
          </Button>
          <Button variant="secondary" onClick={() => void harness.respond("always_allow")}>
            Always allow
          </Button>
          <Button onClick={() => void harness.respond("approve")}>Approve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
