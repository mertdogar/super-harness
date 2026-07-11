// App-level glue: ONE super-line client per node carries everything — the
// boards lobby rows, the CRDT scene docs, and the harness surface — and the
// harness client BORROWS it (createHarnessClient({ client }) detaches on close,
// never closes the socket). Node selection mirrors examples/web:
// VITE_NODE_BASE_PORT (set only by the docker frontend) turns on multi-node —
// node N → ws://<host>:<base+N>/super-line; without it (local `pnpm dev`) one
// node on VITE_CANVAS_URL ?? :4116.
import { createSuperLineClient, type SuperLineClient } from "@super-line/client"
import { webSocketClientTransport } from "@super-line/transport-websocket"
import { crdtCollectionsClient } from "@super-line/collections-crdt-memory"
import { createHarnessClient, type HarnessClient, type HarnessWire } from "@super-harness/react"
import { nanoid } from "nanoid"
import { contract, type CanvasContract } from "../../../shared/contract"

const BASE_PORT = Number(import.meta.env.VITE_NODE_BASE_PORT) || 0
export const MULTINODE = BASE_PORT > 0
export const NODES = MULTINODE
  ? Array.from({ length: Number(import.meta.env.VITE_NODE_COUNT) || 2 }, (_, i) => i + 1)
  : [1]
export const DEFAULT_NODE = 1

function nodeUrl(node: number): string {
  if (MULTINODE) return `ws://${location.hostname}:${BASE_PORT + node}/super-line`
  return import.meta.env.VITE_CANVAS_URL ?? "ws://localhost:4116/super-line"
}

// One shared principal for every tab on every node (the server resolves
// userId ?? resourceId ?? 'local'): it keys the harness.membership RLS — a join
// row written on node-1 admits a reader on node-2 — and the boards write policy
// (rows are inserted with createdBy = this principal).
export const PRINCIPAL = "canvas"

export type CanvasClient = SuperLineClient<CanvasContract, "user">
export interface CanvasClients {
  sl: CanvasClient
  harness: HarnessClient
}

export const freshThreadId = (): string => nanoid()

export function createClientsForNode(node: number, threadId: string): CanvasClients {
  const sl = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url: nodeUrl(node) }),
    role: "user",
    params: { resourceId: PRINCIPAL },
    crdtCollections: crdtCollectionsClient(),
    // Fired when the server rejects a CRDT write (schema/policy) — the client
    // hard-resyncs the replica; log it so a discarded edit isn't a mystery.
    onStoreError: (error, info) => console.warn(`[canvas] rejected write on ${info.store}/${info.id}`, error),
  })
  const harness = createHarnessClient({ client: sl as unknown as HarnessWire, threadId })
  return { sl, harness }
}
