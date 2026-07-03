import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HarnessProvider, type HarnessClient } from "@super-harness/react";
import "./index.css";
import App from "./App.tsx";
import { createClientForNode, DEFAULT_NODE, freshThreadId, NODES } from "./lib/client";

function Root() {
  const [node, setNode] = useState(DEFAULT_NODE);
  const prev = useRef<HarnessClient | null>(null);
  // One client per node. Carry the current thread across the reconnect so
  // flipping the node re-renders the SAME conversation from the new node's
  // PGlite replica. The provider closes the old client + connects the new one
  // whenever this instance changes.
  const client = useMemo(() => {
    const threadId = prev.current?.getSnapshot().threadId ?? freshThreadId();
    prev.current = createClientForNode(node, threadId);
    return prev.current;
  }, [node]);

  return (
    <HarnessProvider client={client}>
      <App nodes={NODES} node={node} onNodeChange={setNode} />
    </HarnessProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
