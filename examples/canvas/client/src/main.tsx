import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { HarnessProvider } from "@super-harness/react"
import "./index.css"
import App from "./App.tsx"
import { boardThreadId, createClientsForNode, DEFAULT_NODE, NODES, type CanvasClients } from "./lib/client"
import { DEFAULT_BOARD_ID } from "../../shared/scene"

function Root() {
  const [node, setNode] = useState(DEFAULT_NODE)
  const [clients, setClients] = useState<CanvasClients | null>(null)
  // The { sl, harness } pair lives in an EFFECT, not a useMemo: the harness
  // BORROWS the super-line socket, so we must close it ourselves on a node
  // swap — and a close() inside a memo runs during render, which breaks under
  // StrictMode's double-invoke (the committed pair can be the one the second
  // render already closed → every request rejects "Client closed"). The effect
  // owns the lifecycle instead: create on mount/node change, close on cleanup.
  // The client is seeded with the DEFAULT board's thread; App re-points it to
  // the active board via switchThread, so thread identity follows the board
  // (shared across tabs), not the tab — a node swap re-derives the same id.
  useEffect(() => {
    const pair = createClientsForNode(node, boardThreadId(DEFAULT_BOARD_ID))
    setClients(pair)
    return () => pair.sl.close()
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
