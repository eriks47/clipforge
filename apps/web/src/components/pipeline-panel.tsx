import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  NextIcon,
  RepeatIcon,
} from "@hugeicons/core-free-icons"
import type { Job } from "@clipforge/shared"
import { api } from "@/lib/api"
import { formatEta, JOB_LABELS } from "@/lib/format"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"

const RERUNNABLE = new Set([
  "proxy",
  "audio",
  "transcribe",
  "nominate",
  "audio_features",
  "signals",
  "visual",
  "scenes",
  "heatmap",
  "chat",
  "candidates",
])

/** Latest job per type, in pipeline order. */
export function latestJobs(jobs: Job[]): Job[] {
  const order = [
    "download",
    "probe",
    "proxy",
    "audio",
    "transcribe",
    "nominate",
    "audio_features",
    "signals",
    "visual",
    "scenes",
    "heatmap",
    "chat",
    "candidates",
    "rank",
  ]
  const byType = new Map<string, Job>()
  for (const j of jobs) {
    if (!order.includes(j.type)) continue
    const prev = byType.get(j.type)
    if (!prev || prev.createdAt < j.createdAt) byType.set(j.type, j)
  }
  return order.map((t) => byType.get(t)).filter((j): j is Job => !!j)
}

export function JobRow({
  job,
  projectId,
  blocked,
}: {
  job: Job
  projectId: string | null
  blocked?: boolean
}) {
  const [open, setOpen] = useState(false)
  const act = useMutation({
    mutationFn: (a: "retry" | "cancel" | "skip" | "rerun"): Promise<unknown> =>
      a === "retry"
        ? api.retryJob(job.id)
        : a === "cancel"
          ? api.cancelJob(job.id)
          : a === "skip"
            ? api.skipJob(job.id)
            : api.rerunStep(projectId ?? "", job.type),
    onError: (e) => toast.error(e.message),
  })
  const eta =
    job.status === "running" ? formatEta(job.progress, job.startedAt) : null
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-b last:border-b-0"
    >
      <div className="flex items-center gap-3 py-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Toggle log">
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={open ? "" : "-rotate-90"}
            />
          </Button>
        </CollapsibleTrigger>
        <div className="w-28 shrink-0 text-xs font-medium">
          {JOB_LABELS[job.type] ?? job.type}
        </div>
        <div className="w-24 shrink-0">
          {blocked && job.status === "queued" ? (
            <span className="text-xs text-muted-foreground">waiting…</span>
          ) : (
            <StatusBadge status={job.status} />
          )}
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {job.status === "running" ? (
            <>
              <Progress value={job.progress * 100} className="flex-1" />
              <span className="w-24 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {Math.round(job.progress * 100)}%{eta ? ` · ${eta}` : ""}
              </span>
            </>
          ) : job.error ? (
            <span
              className="truncate text-xs text-destructive"
              title={job.error}
            >
              {job.error.split("\n")[0]}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {job.status === "failed" || job.status === "canceled" ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => act.mutate("retry")}
                    aria-label="Retry"
                  >
                    <HugeiconsIcon
                      icon={ArrowReloadHorizontalIcon}
                      strokeWidth={2}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Retry</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => act.mutate("skip")}
                    aria-label="Skip"
                  >
                    <HugeiconsIcon icon={NextIcon} strokeWidth={2} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Skip (continue without this step)
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}
          {job.status === "running" || job.status === "queued" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => act.mutate("cancel")}
                  aria-label="Cancel"
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Cancel</TooltipContent>
            </Tooltip>
          ) : null}
          {job.status === "done" && projectId && RERUNNABLE.has(job.type) ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => act.mutate("rerun")}
                  aria-label="Re-run"
                >
                  <HugeiconsIcon icon={RepeatIcon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Re-run (clears cache)</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <CollapsibleContent>
        <ScrollArea className="mb-2 h-48 border bg-muted/40">
          <pre className="p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {job.log || "(no output yet)"}
          </pre>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function PipelinePanel({
  jobs,
  projectId,
}: {
  jobs: Job[]
  projectId: string
}) {
  const latest = latestJobs(jobs)
  const done = new Set(
    latest.filter((j) => j.status === "done").map((j) => j.id)
  )
  return (
    <div className="flex flex-col">
      {latest.map((j) => (
        <JobRow
          key={j.id}
          job={j}
          projectId={projectId}
          blocked={j.dependsOn.some((d) => !done.has(d))}
        />
      ))}
    </div>
  )
}
