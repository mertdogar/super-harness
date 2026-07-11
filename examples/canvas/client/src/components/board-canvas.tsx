// The 400x400 board, mirroring upstream ai-canvas: absolutely-positioned
// labelled squares, drag to move (pointer events → one merging doc.update per
// move), double-click to delete. Agent edits arrive as CRDT merges on the same
// doc — even mid-drag, because concurrent edits to different fields merge.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { COLORS, newShapeId, readShapes, topOrder } from "../../../shared/scene"
import type { SceneDoc } from "@/hooks/use-doc"
import { Button } from "@/components/ui/button"

const BOARD = 400
const SHAPE = 44

export function BoardCanvas({ doc }: { doc: SceneDoc }) {
  const boardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const [, setDragging] = useState(false)
  const { scene, ready, missing, deleted, update, deletePath } = doc

  if (deleted) return <Placeholder text="This board was deleted." />
  if (missing) return <Placeholder text="No scene for this board yet — retrying…" />
  if (!ready && scene === undefined) return <Placeholder text="connecting…" />

  const shapes = readShapes(scene)

  const clamp = (v: number): number => Math.max(0, Math.min(BOARD - SHAPE, Math.round(v)))

  const onAdd = (): void => {
    const id = newShapeId()
    const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? "#888"
    update({
      shapes: {
        [id]: {
          x: clamp(Math.random() * (BOARD - SHAPE)),
          y: clamp(Math.random() * (BOARD - SHAPE)),
          color,
          label: id.slice(2),
          order: topOrder(scene),
        },
      },
    })
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string, x: number, y: number): void => {
    update({ shapes: { [id]: { order: topOrder(scene) } } }) // bring to front
    const rect = boardRef.current?.getBoundingClientRect()
    drag.current = { id, dx: e.clientX - (rect?.left ?? 0) - x, dy: e.clientY - (rect?.top ?? 0) - y }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const rect = boardRef.current?.getBoundingClientRect()
    const x = clamp(e.clientX - (rect?.left ?? 0) - d.dx)
    const y = clamp(e.clientY - (rect?.top ?? 0) - d.dy)
    update({ shapes: { [d.id]: { x, y } } })
  }

  const onPointerUp = (): void => {
    drag.current = null
    setDragging(false)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {shapes.length} shape{shapes.length === 1 ? "" : "s"} · drag to move · double-click to delete
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onAdd}>
          Add shape
        </Button>
      </div>
      <div
        ref={boardRef}
        className="relative shrink-0 overflow-hidden rounded-lg border bg-muted/20"
        style={{ width: BOARD, height: BOARD }}
      >
        {shapes.map((s) => (
          <div
            key={s.id}
            className="absolute flex cursor-grab touch-none select-none items-center justify-center rounded-md font-mono text-white text-xs shadow-sm active:cursor-grabbing"
            style={{ left: s.x, top: s.y, width: SHAPE, height: SHAPE, background: s.color, zIndex: s.order }}
            onPointerDown={(e) => onPointerDown(e, s.id, s.x, s.y)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => deletePath(["shapes", s.id])}
            title="drag to move · double-click to delete"
          >
            {s.label}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-xs">palette:</span>
        {COLORS.map((c) => (
          <span key={c} className="size-3 rounded-sm" style={{ background: c }} title={c} />
        ))}
      </div>
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed text-muted-foreground text-sm"
      style={{ width: BOARD, height: BOARD }}
    >
      {text}
    </div>
  )
}
