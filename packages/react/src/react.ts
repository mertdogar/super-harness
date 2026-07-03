// React bindings. Plain .ts on purpose (createElement, no JSX) so bundlers
// consuming this package as workspace source never need a JSX transform for it.
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react"
import type { HarnessClient, HarnessState } from "./harness-client"

const HarnessContext = createContext<HarnessClient | null>(null)

// Owns the connection lifecycle: connect on mount, close on unmount.
// StrictMode-safe — connect() is idempotent and abandons itself if the client
// was closed mid-handshake.
export function HarnessProvider(props: { client: HarnessClient; children?: ReactNode }): ReactElement {
  const { client, children } = props
  useEffect(() => {
    void client.connect()
    return () => client.close()
  }, [client])
  return createElement(HarnessContext.Provider, { value: client }, children)
}

export function useHarnessClient(): HarnessClient {
  const client = useContext(HarnessContext)
  if (!client) throw new Error("useHarnessClient must be used inside <HarnessProvider>")
  return client
}

export function useHarness(): HarnessState {
  const client = useHarnessClient()
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
}
