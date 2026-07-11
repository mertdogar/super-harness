import { z } from "zod"
import { defineContract } from "@super-line/core"
import { harnessContract } from "@super-harness/shared"
import { sceneSchema } from "./scene.js"

// The lobby: one LWW row per board. Client-writable (create/rename/delete)
// under an RLS write policy; the scene doc for a board shares its id.
export const boardSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  createdBy: z.string(),
  createdAt: z.number(),
})
export type Board = z.infer<typeof boardSchema>

// harnessContract() contributes the four harness.* collections + the harness
// surface; the host adds its own two collections beside them: `boards` (typed
// rows, TanStack-driven lobby) and `scenes` (CRDT documents, one per board).
export const contract = defineContract({
  plugins: [harnessContract()],
  collections: {
    boards: { schema: boardSchema, key: "id" },
    scenes: { schema: sceneSchema, crdt: { mode: "document" } },
  },
  roles: { user: {} },
})

export type CanvasContract = typeof contract
