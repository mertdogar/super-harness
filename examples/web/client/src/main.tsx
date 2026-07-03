import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HarnessProvider } from "@super-harness/react";
import "./index.css";
import App from "./App.tsx";
import { harnessClient } from "./lib/client";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HarnessProvider client={harnessClient}>
      <App />
    </HarnessProvider>
  </StrictMode>,
);
