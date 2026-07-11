import { StrictMode, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { HarnessProvider } from "@super-harness/react"
import "./index.css"
import App from "./App.tsx"
import { createClientsForNode, DEFAULT_NODE, freshThreadId, NODES, type CanvasClients } from "./lib/client"

function Root() {
  const [node, setNode] = useState(DEFAULT_NODE)
  const [clients, setClients] = useState<CanvasClients | null>(null)
  const threadId = useRef(freshThreadId())
  // The { sl, harness } pair lives in an EFFECT, not a useMemo: the harness
  // BORROWS the super-line socket, so we must close it ourselves on a node
  // swap — and a close() inside a memo runs during render, which breaks under
  // StrictMode's double-invoke (the committed pair can be the one the second
  // render already closed → every request rejects "Client closed"). The effect
  // owns the lifecycle instead: create on mount/node change, close on cleanup,
  // carrying the CURRENT threadId across so the SAME conversation re-renders
  // from the new node.
  useEffect(() => {
    const pair = createClientsForNode(node, threadId.current)
    setClients(pair)
    return () => {
      threadId.current = pair.harness.getSnapshot().threadId
      pair.sl.close()
    }
  }, [node])

  if (!clients) return null
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
