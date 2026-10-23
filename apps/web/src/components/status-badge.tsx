import type { JobStatus, ProjectStatus, ClipStatus } from "@clipforge/shared"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"

type Any = ProjectStatus | JobStatus | ClipStatus

const VARIANT: Record<
  Any,
  "default" | "secondary" | "outline" | "destructive"
> = {
  uploading: "secondary",
  downloading: "secondary",
  analyzing: "secondary",
  ready: "default",
  error: "destructive",
  queued: "outline",
  running: "secondary",
  done: "default",
  failed: "destructive",
  canceled: "outline",
  editing: "outline",
  rendering: "secondary",
  rendered: "default",
}

const BUSY = new Set<Any>([
  "uploading",
  "downloading",
  "analyzing",
  "running",
  "rendering",
])

export function StatusBadge({ status }: { status: Any }) {
  return (
    <Badge variant={VARIANT[status]} className="capitalize">
      {BUSY.has(status) ? <Spinner data-icon="inline-start" /> : null}
      {status}
    </Badge>
  )
}
