// A hand-written hook over the raw CRDT DocHandle (the app shares ONE
// super-line client, so it can't use createSuperLineHooks' provider-bound
// useDoc): open the scene doc on mount / id change, close on cleanup, feed
// React via useSyncExternalStore. `doc.ready` REJECTS on NOT_FOUND — a fresh
// board's doc is created server-side off the boards-insert change feed, so a
// rejection is usually a race (or a lagging cluster replica): surface it as
// `missing` and retry briefly instead of crashing.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import type { DocHandle } from "@super-line/client"
import type { Scene, ScenePatch } from "../../../shared/scene"
import type { CanvasClient } from "@/lib/client"

const RETRIES = 10
const RETRY_MS = 1500

export interface SceneDoc {
  scene: Scene | undefined
  /** catch-up snapshot applied — safe to treat the scene as current */
  ready: boolean
  /** open was rejected (NOT_FOUND) — board scene absent (still retried a few times) */
  missing: boolean
  /** the server fanned out a doc delete while we were viewing it */
  deleted: boolean
  update: (patch: ScenePatch) => void
  deletePath: (path: (string | number)[]) => void
}

export function useDoc(sl: CanvasClient, id: string): SceneDoc {
  const [doc, setDoc] = useState<DocHandle<Scene> | null>(null)
  const [ready, setReady] = useState(false)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let closed = false
    let handle: DocHandle<Scene> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let tries = 0
    setReady(false)
    setMissing(false)

    const open = (): void => {
      handle = sl.collection("scenes").open(id)
      setDoc(handle)
      handle.ready.then(
        () => {
          if (closed) return
          setReady(true)
          setMissing(false)
        },
        () => {
          if (closed) return
          handle?.close()
          handle = null
          setDoc(null)
          setMissing(true)
          if (tries++ < RETRIES) timer = setTimeout(open, RETRY_MS)
        },
      )
    }
    open()

    return () => {
      closed = true
      clearTimeout(timer)
      handle?.close()
      setDoc(null)
    }
  }, [sl, id])

  const subscribe = useCallback((cb: () => void) => (doc ? doc.subscribe(cb) : () => {}), [doc])
  const scene = useSyncExternalStore(subscribe, () => doc?.getSnapshot())
  const deleted = useSyncExternalStore(subscribe, () => doc?.deleted ?? false)

  // The doc merges deeply (document mode), so a patch carrying just the changed
  // fields of one shape is fine at runtime; the cast relaxes the per-field type.
  const update = useCallback((patch: ScenePatch) => doc?.update(patch as unknown as Partial<Scene>), [doc])
  const deletePath = useCallback((path: (string | number)[]) => doc?.delete(path), [doc])

  return { scene, ready, missing, deleted, update, deletePath }
}
