import { StrictMode, useMemo } from "react"
import { createRoot } from "react-dom/client"
import { HarnessProvider } from "@super-harness/react"
import "./index.css"
import App from "./App.tsx"
import { createPlanBoardClient } from "./lib/client"

function Root() {
  // One stable client for the app's lifetime — HarnessProvider keys its
  // connect/close effect on this instance, so it must not change per render.
  const client = useMemo(() => createPlanBoardClient(), [])
  return (
    <HarnessProvider client={client}>
      <App />
    </HarnessProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
