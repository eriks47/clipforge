import { useMemo, useState } from "react"
import { Link } from "react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  Download04Icon,
  Edit02Icon,
  FolderOpenIcon,
  ArrowReloadHorizontalIcon,
  Rocket01Icon,
} from "@hugeicons/core-free-icons"
import type { Job } from "@clipforge/shared"
import { api, renderUrl, type ClipWithProject } from "@/lib/api"
import { formatDuration, formatEta, formatRelative } from "@/lib/format"
import { StatusBadge } from "@/components/status-badge"
import { JobRow } from "@/components/pipeline-panel"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Field, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"

function latestJob(jobs: Job[], clipId: string, type: string): Job | undefined {
  return jobs
    .filter((j) => j.clipId === clipId && j.type === type)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

type TriState = "keep" | "on" | "off"
const triToBool = (v: TriState) => (v === "keep" ? undefined : v === "on")

/** keep each clip's setting / force on / force off for the whole batch */
function TriSelect({
  label,
  value,
  onChange,
  labels = { on: "on (LLM picks)", off: "off" },
}: {
  label: string
  value: TriState
  onChange: (v: TriState) => void
  labels?: { on: string; off: string }
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TriState)}>
      <SelectTrigger className="w-56" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="keep">{label}: keep each clip's</SelectItem>
          <SelectItem value="on">
            {label}: {labels.on}
          </SelectItem>
          <SelectItem value="off">
            {label}: {labels.off}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function ClipRow({ clip, jobs }: { clip: ClipWithProject; jobs: Job[] }) {
  const job = latestJob(jobs, clip.id, "render")
  const faces = latestJob(jobs, clip.id, "faces")
  const emojiJob = latestJob(jobs, clip.id, "emoji")
  const active = job && (job.status === "running" || job.status === "queued")
  const render = useMutation({
    mutationFn: () => api.renderClip(clip.id),
    onError: (e) => toast.error(e.message),
  })
  const cancel = useMutation({
    mutationFn: (jid: string) => api.cancelJob(jid),
    onError: (e) => toast.error(e.message),
  })
  const url = renderUrl(clip.renderPath)
  return (
    <TableRow>
      <TableCell className="max-w-72">
        <Link
          to={`/clips/${clip.id}`}
          className="block truncate font-medium hover:underline"
        >
          {clip.name}
        </Link>
        <span className="block truncate text-xs text-muted-foreground">
          {clip.projectTitle}
        </span>
      </TableCell>
      <TableCell className="font-mono text-xs">
        {formatDuration(clip.end - clip.start)}
      </TableCell>
      <TableCell>
        <StatusBadge
          status={
            active
              ? job.status === "running"
                ? "rendering"
                : "queued"
              : clip.status
          }
        />
      </TableCell>
      <TableCell className="w-64">
        {active ? (
          <div className="flex flex-col gap-1">
            <Progress value={job.progress * 100} />
            <span className="font-mono text-[10px] text-muted-foreground">
              {faces &&
              (faces.status === "running" || faces.status === "queued")
                ? "detecting faces… "
                : ""}
              {emojiJob &&
              (emojiJob.status === "running" || emojiJob.status === "queued")
                ? "picking emojis… "
                : ""}
              {Math.round(job.progress * 100)}%{" "}
              {formatEta(job.progress, job.startedAt) ?? ""}
            </span>
          </div>
        ) : job?.status === "failed" ? (
          <span
            className="line-clamp-2 text-xs text-destructive"
            title={job.error ?? ""}
          >
            {job.error}
          </span>
        ) : clip.renderedAt ? (
          <span className="text-xs text-muted-foreground">
            {formatRelative(clip.renderedAt)}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => cancel.mutate(job.id)}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant={clip.renderPath ? "ghost" : "secondary"}
              onClick={() => render.mutate()}
            >
              <HugeiconsIcon
                icon={
                  job?.status === "failed"
                    ? ArrowReloadHorizontalIcon
                    : Rocket01Icon
                }
                strokeWidth={2}
                data-icon="inline-start"
              />
              {job?.status === "failed"
                ? "Retry"
                : clip.renderPath
                  ? "Re-render"
                  : "Render"}
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" asChild>
            <Link to={`/clips/${clip.id}`} aria-label="Edit">
              <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
            </Link>
          </Button>
          {url ? (
            <>
              <Button size="icon-sm" variant="ghost" asChild>
                <a href={url} download aria-label="Download">
                  <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
                </a>
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => void api.openClipFolder(clip.id)}
                aria-label="Open folder"
              >
                <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
              </Button>
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

export function RendersPage() {
  const clips = useQuery({
    queryKey: ["clips"],
    queryFn: api.clips,
    refetchInterval: 20_000,
  })
  const jobs = useQuery({ queryKey: ["render-jobs"], queryFn: api.renderJobs })
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects })
  const [projectId, setProjectId] = useState<string>("")
  const [applyDefault, setApplyDefault] = useState(false)
  const [onlyNew, setOnlyNew] = useState(true)
  const [hookEmoji, setHookEmoji] = useState<TriState>("keep")
  const [captionEmoji, setCaptionEmoji] = useState<TriState>("keep")
  const [hookWhole, setHookWhole] = useState<TriState>("keep")
  const batch = useMutation({
    mutationFn: () =>
      api.renderAll(projectId, {
        applyDefaultPreset: applyDefault,
        onlyUnrendered: onlyNew,
        hookEmoji: triToBool(hookEmoji),
        captionEmoji: triToBool(captionEmoji),
        hookWholeVideo: triToBool(hookWhole),
      }),
    onSuccess: (r) =>
      toast.success(`${r.queued} render${r.queued === 1 ? "" : "s"} queued`),
    onError: (e) => toast.error(e.message),
  })
  const recentJobs = useMemo(
    () =>
      (jobs.data ?? [])
        .filter((j) => ["render", "metadata", "emoji"].includes(j.type))
        .slice(0, 10),
    [jobs.data]
  )
  const projectsWithClips = (projects.data ?? []).filter((p) =>
    (clips.data ?? []).some((c) => c.projectId === p.id)
  )

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          Render queue
        </h1>
        <p className="text-sm text-muted-foreground">
          1080×1920 H.264 high, AAC 192k, loudness-normalized. Renders run one
          at a time (configurable).
        </p>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Batch render</CardTitle>
          <CardDescription>
            Render every approved clip of a project.
          </CardDescription>
          <CardAction>
            <Button
              onClick={() => batch.mutate()}
              disabled={!projectId || batch.isPending}
            >
              <HugeiconsIcon
                icon={Rocket01Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
              Render all
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-6">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Choose project" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projectsWithClips.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Field orientation="horizontal" className="w-auto">
            <Switch
              id="only-new"
              checked={onlyNew}
              onCheckedChange={setOnlyNew}
            />
            <FieldLabel htmlFor="only-new">Skip already rendered</FieldLabel>
          </Field>
          <Field orientation="horizontal" className="w-auto">
            <Switch
              id="apply-default"
              checked={applyDefault}
              onCheckedChange={setApplyDefault}
            />
            <FieldLabel htmlFor="apply-default">
              Apply default preset first
            </FieldLabel>
          </Field>
          <TriSelect
            label="Hook"
            value={hookWhole}
            onChange={setHookWhole}
            labels={{ on: "whole video", off: "normal duration" }}
          />
          <TriSelect
            label="Hook emoji"
            value={hookEmoji}
            onChange={setHookEmoji}
          />
          <TriSelect
            label="Caption emojis"
            value={captionEmoji}
            onChange={setCaptionEmoji}
          />
        </CardContent>
      </Card>

      {clips.isLoading ? (
        <Skeleton className="h-64" />
      ) : clips.data?.length ? (
        <div className="border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Clip</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clips.data.map((c) => (
                <ClipRow key={c.id} clip={c} jobs={jobs.data ?? []} />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No clips yet</EmptyTitle>
            <EmptyDescription>
              Approve candidates on a project's review page to create clips.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {recentJobs.length ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Recent render jobs</CardTitle>
            <CardDescription>Expand a row to see the log.</CardDescription>
          </CardHeader>
          <CardContent>
            {recentJobs.map((j) => (
              <JobRow key={j.id} job={j} projectId={null} />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
