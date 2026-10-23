import { useCallback, useEffect, useRef, useState } from "react"

interface History<T> {
  past: T[]
  present: T
  future: T[]
}

const LIMIT = 200
/** consecutive edits of the same field within this window collapse into one undo step (slider drags) */
const MERGE_MS = 700

/** Undo/redo state for the edit config. `set(value, key)` merges rapid edits that share a key. */
export function useHistory<T>(initial: T) {
  const [h, setH] = useState<History<T>>({
    past: [],
    present: initial,
    future: [],
  })
  const last = useRef<{ key: string; at: number } | null>(null)

  const set = useCallback((next: T | ((prev: T) => T), key = "") => {
    setH((cur) => {
      const value =
        typeof next === "function" ? (next as (p: T) => T)(cur.present) : next
      if (value === cur.present) return cur
      const now = Date.now()
      const merge =
        key !== "" &&
        last.current?.key === key &&
        now - last.current.at < MERGE_MS
      last.current = { key, at: now }
      if (merge) return { ...cur, present: value, future: [] }
      return {
        past: [...cur.past, cur.present].slice(-LIMIT),
        present: value,
        future: [],
      }
    })
  }, [])

  const reset = useCallback((value: T) => {
    last.current = null
    setH({ past: [], present: value, future: [] })
  }, [])

  const undo = useCallback(() => {
    last.current = null
    setH((cur) =>
      cur.past.length
        ? {
            past: cur.past.slice(0, -1),
            present: cur.past[cur.past.length - 1],
            future: [cur.present, ...cur.future],
          }
        : cur
    )
  }, [])

  const redo = useCallback(() => {
    last.current = null
    setH((cur) =>
      cur.future.length
        ? {
            past: [...cur.past, cur.present],
            present: cur.future[0],
            future: cur.future.slice(1),
          }
        : cur
    )
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.isContentEditable || ["INPUT", "TEXTAREA"].includes(t.tagName))
      )
        return
      if (
        !(e.ctrlKey || e.metaKey) ||
        (e.key.toLowerCase() !== "z" && e.key.toLowerCase() !== "y")
      )
        return
      e.preventDefault()
      if (e.key.toLowerCase() === "y" || e.shiftKey) redo()
      else undo()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo])

  return {
    value: h.present,
    set,
    reset,
    undo,
    redo,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  }
}
