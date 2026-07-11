import { z } from "zod"

// The scene lives in a CRDT document collection: declared on the contract with
// this schema, so the server validate-before-commits every write against it.
// `document` mode makes it a recursive CRDT — concurrent edits to different
// shapes/fields MERGE, not clobber.
//
// IMPORTANT (ADR-0007 constraint): validate-before-commit runs against the
// *post-merge* CRDT state, and a merge can transiently leave an overwritten
// field absent (a concurrent overwrite is internally a delete-then-insert). A
// CRDT-document schema must NOT hard-require a concurrently-overwritten field —
// rejection would resync-churn the doc until it wedges. Every field is
// therefore `.catch(default)`: a transiently-missing/invalid field coerces to
// a default instead of rejecting, and the next write restores the real value.
export const shapeSchema = z.object({
  x: z.number().catch(0),
  y: z.number().catch(0),
  color: z.string().catch("#888"),
  label: z.string().catch(""),
  order: z.number().catch(0),
})
export const sceneSchema = z.object({ shapes: z.record(z.string(), shapeSchema) })

export type Shape = z.infer<typeof shapeSchema>
export type Scene = z.infer<typeof sceneSchema>

// A partial scene write — what update() merges in. The doc merges deeply, so a
// write can carry just the changed fields of one shape.
export type ScenePatch = { shapes: Record<string, Partial<Shape>> }

export const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"]

export function readShapes(scene: Scene | undefined): Array<Shape & { id: string }> {
  return Object.entries(scene?.shapes ?? {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => a.order - b.order)
}

export function topOrder(scene: Scene | undefined): number {
  let max = 0
  for (const s of Object.values(scene?.shapes ?? {})) max = Math.max(max, s.order ?? 0)
  return max + 1
}

export function newShapeId(): string {
  return `S_${Math.random().toString(36).slice(2, 8)}`
}

export function newBoardId(): string {
  return `B_${Math.random().toString(36).slice(2, 8)}`
}

export const DEFAULT_BOARD_ID = "board"
