// The lobby: a TanStack DB collection over the `boards` LWW rows. Every
// mutation is optimistic — the row moves instantly and the server's write
// policy (creator-only) rolls it back on rejection, which we surface as a
// notice instead of throwing.
import { useEffect, useMemo, useState } from "react"
import { createCollection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { superLineCollectionOptions } from "@super-line/tanstack-db"
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { contract } from "../../../shared/contract"
import { DEFAULT_BOARD_ID, newBoardId } from "../../../shared/scene"
import { PRINCIPAL, type CanvasClient } from "@/lib/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// Re-created per node swap (fresh client). Override the adapter's default
// `superline:boards` id — two live instances during the swap would collide in
// TanStack's registry.
let seq = 0
const boardsCollection = (sl: CanvasClient) =>
  createCollection({ ...superLineCollectionOptions(sl, contract, "boards"), id: `superline:boards:${++seq}` })

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function BoardsLobby({
  sl,
  activeBoardId,
  onSelect,
}: {
  sl: CanvasClient
  activeBoardId: string
  onSelect: (id: string) => void
}) {
  // Deliberately NO cleanup() on unmount: StrictMode remounts reuse this
  // memoized collection, and a cleaned-up TanStack collection (0.5.x) never
  // restarts sync — the lobby would stay empty forever. The collection's real
  // lifetime is the sl client's: a node swap closes the old socket (ending its
  // sync feed), and the seq-suffixed id keeps the registry collision-free.
  const boards = useMemo(() => boardsCollection(sl), [sl])
  const { data } = useLiveQuery((q) => q.from({ b: boards }).orderBy(({ b }) => b.createdAt, "asc"), [boards])

  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  // Active board deleted elsewhere (its row left the live query) — hop home.
  useEffect(() => {
    if (data.length > 0 && !data.some((b) => b.id === activeBoardId)) onSelect(DEFAULT_BOARD_ID)
  }, [data, activeBoardId, onSelect])

  const addBoard = (): void => {
    const id = newBoardId()
    boards
      .insert({ id, name: `Board ${data.length + 1}`, createdBy: PRINCIPAL, createdAt: Date.now() })
      .isPersisted.promise.catch((err) => setNotice(errMsg(err)))
    onSelect(id)
  }

  const commitRename = (id: string): void => {
    const name = draft.trim()
    setEditing(null)
    if (!name) return
    boards
      .update(id, (b) => {
        b.name = name
      })
      .isPersisted.promise.catch((err) => setNotice(errMsg(err)))
  }

  const removeBoard = (id: string): void => {
    boards.delete(id).isPersisted.promise.catch((err) => setNotice(errMsg(err)))
    if (id === activeBoardId) onSelect(DEFAULT_BOARD_ID)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-muted-foreground text-xs uppercase tracking-wide">Boards</h2>
        <Button size="sm" variant="outline" onClick={addBoard}>
          <PlusIcon className="size-4" /> New board
        </Button>
      </div>
      {notice && <p className="text-destructive text-xs">{notice}</p>}
      <ul className="flex flex-col gap-1">
        {data.map((b) => (
          <li
            key={b.id}
            className={cn(
              "group flex items-center gap-1 rounded-md border px-2 py-1",
              b.id === activeBoardId ? "border-primary bg-muted" : "border-transparent hover:bg-muted/50",
            )}
          >
            {editing === b.id ? (
              <>
                <Input
                  autoFocus
                  value={draft}
                  className="h-7 flex-1 text-sm"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(b.id)
                    if (e.key === "Escape") setEditing(null)
                  }}
                />
                <Button size="icon" variant="ghost" className="size-7" title="Save name" onClick={() => commitRename(b.id)}>
                  <CheckIcon className="size-4" />
                </Button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="flex-1 truncate text-left text-sm"
                  title={b.id}
                  onClick={() => onSelect(b.id)}
                >
                  {b.name}
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 opacity-0 group-hover:opacity-100"
                  title="Rename"
                  onClick={() => {
                    setEditing(b.id)
                    setDraft(b.name)
                  }}
                >
                  <PencilIcon className="size-4" />
                </Button>
                {b.id !== DEFAULT_BOARD_ID && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 opacity-0 group-hover:opacity-100"
                    title="Delete board"
                    onClick={() => removeBoard(b.id)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
