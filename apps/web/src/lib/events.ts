import { useEffect, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { Job, ServerEvent } from "@clipforge/shared"

function upsertJob(list: Job[] | undefined, job: Job): Job[] | undefined {
  if (!list) return list
  const i = list.findIndex((j) => j.id === job.id)
  if (i === -1) return [job, ...list]
  const next = list.slice()
  // events carry a truncated log; keep the longer one
  next[i] = {
    ...job,
    log: job.log.length >= list[i].log.length ? job.log : list[i].log,
  }
  return next
}

function handle(qc: QueryClient, ev: ServerEvent) {
  switch (ev.type) {
    case "job": {
      const j = ev.job
      if (j.projectId)
        qc.setQueryData<Job[]>(["jobs", j.projectId], (l) => upsertJob(l, j))
      qc.setQueryData<Job[]>(["render-jobs"], (l) =>
        ["render", "faces", "metadata", "emoji"].includes(j.type)
          ? upsertJob(l, j)
          : l
      )
      if (
        j.status === "done" ||
        j.status === "failed" ||
        j.status === "canceled"
      ) {
        if (j.projectId) {
          void qc.invalidateQueries({ queryKey: ["project", j.projectId] })
          if (
            [
              "transcribe",
              "audio_features",
              "signals",
              "visual",
              "scenes",
              "heatmap",
              "chat",
            ].includes(j.type)
          )
            void qc.invalidateQueries({ queryKey: ["analysis", j.projectId] })
        }
        if (
          j.clipId &&
          ["faces", "metadata", "render", "emoji"].includes(j.type)
        ) {
          void qc.invalidateQueries({ queryKey: ["clip-context", j.clipId] })
          void qc.invalidateQueries({ queryKey: ["clips"] })
          if (j.type === "render")
            void qc.invalidateQueries({ queryKey: ["artifacts"] })
        }
        void qc.invalidateQueries({ queryKey: ["projects"] })
      }
      break
    }
    case "project":
      void qc.invalidateQueries({ queryKey: ["project", ev.projectId] })
      void qc.invalidateQueries({ queryKey: ["projects"] })
      break
    case "candidates":
      void qc.invalidateQueries({ queryKey: ["candidates", ev.projectId] })
      void qc.invalidateQueries({ queryKey: ["projects"] })
      break
    case "clip":
      void qc.invalidateQueries({ queryKey: ["clips"] })
      void qc.invalidateQueries({ queryKey: ["project-clips", ev.projectId] })
      break
  }
}

/** Subscribe to server-sent events and keep the query cache fresh. Returns connection state. */
export function useServerEvents(): boolean {
  const qc = useQueryClient()
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const es = new EventSource("/api/events")
    // EventSource reconnects by itself; after an outage (server restart) refetch everything,
    // since any events sent in between were missed and failed queries need another try.
    let lost = false
    es.onopen = () => {
      setConnected(true)
      if (lost) void qc.invalidateQueries()
      lost = false
    }
    es.onerror = () => {
      setConnected(false)
      lost = true
    }
    es.onmessage = (m) => {
      try {
        handle(qc, JSON.parse(m.data as string) as ServerEvent)
      } catch {
        // ignore malformed events
      }
    }
    return () => es.close()
  }, [qc])
  return connected
}
