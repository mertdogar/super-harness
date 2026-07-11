import { StrictMode, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { HarnessProvider } from "@super-harness/react"
import "./index.css"
import App from "./App.tsx"
import { createClientsForNode, DEFAULT_NODE, freshThreadId, NODES, type CanvasClients } from "./lib/client"

function Root() {
  const [node, setNode] = useState(DEFAULT_NODE)
  const prev = useRef<CanvasClients | null>(null)
  // One { sl, harness } pair per node (web's pattern). The harness BORROWS the
  // super-line socket, so the provider's close() only detaches listeners — we
  // close the previous socket ourselves on a node swap, and carry the current
  // threadId across so the SAME conversation re-renders from the new node.
  const clients = useMemo(() => {
    const threadId = prev.current?.harness.getSnapshot().threadId ?? freshThreadId()
    prev.current?.sl.close()
    prev.current = createClientsForNode(node, threadId)
    return prev.current
  }, [node])

  return (
    <HarnessProvider client={clients.harness}>
      <App sl={clients.sl} nodes={NODES} node={node} onNodeChange={setNode} />
    </HarnessProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
