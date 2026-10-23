import { useMemo, useState } from "react"
import { Link } from "react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Download04Icon,
  FolderOpenIcon,
  PencilEdit02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import type { Artifact } from "@clipforge/shared"
import { api, fileUrl } from "@/lib/api"
import { formatBytes, formatRelative } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Pause every other artifact video when one starts, so only one plays at a time. */
function pauseOthers(e: React.SyntheticEvent<HTMLVideoElement>) {
  for (const v of document.querySelectorAll<HTMLVideoElement>(
    "video[data-artifact]"
  ))
    if (v !== e.currentTarget) v.pause()
}

function ArtifactCard({ a }: { a: Artifact }) {
  const url = fileUrl(a.url)
  const open = useMutation({
    mutationFn: () => api.openArtifactFolder(a.projectId),
    onError: (e) => toast.error(e.message),
  })
  return (
    <div className="flex min-w-0 flex-col border bg-card">
      <video
        data-artifact
        // #t= makes the browser show a frame instead of black before playback
        src={`${url}#t=0.5`}
        controls
        preload="metadata"
        playsInline
        onPlay={pauseOthers}
        className="aspect-[9/16] w-full bg-black object-contain"
      />
      <div className="flex min-w-0 flex-col gap-1 p-2">
        <span className="line-clamp-2 text-sm font-medium" title={a.title}>
          {a.title}
        </span>
        <Link
          to={`/projects/${a.projectId}`}
          className="truncate text-xs text-muted-foreground hover:underline"
          title={a.projectTitle ?? a.projectId}
        >
          {a.projectTitle ?? a.projectId}
        </Link>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-muted-foreground">
            {formatBytes(a.sizeBytes)} · {formatRelative(a.modifiedAt)}
          </span>
          <div className="ml-auto flex items-center">
            {a.clipId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" asChild>
                    <Link to={`/clips/${a.clipId}`} aria-label="Edit clip">
                      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Open in editor</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" asChild>
                  <a href={url} download={a.file} aria-label="Download">
                    <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => open.mutate()}
                  aria-label="Open folder"
                >
                  <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open folder</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ArtifactsPage() {
  const q = useQuery({ queryKey: ["artifacts"], queryFn: api.artifacts })
  const [project, setProject] = useState("__all")
  const [search, setSearch] = useState("")
  const all = useMemo(() => q.data ?? [], [q.data])
  const projects = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of all) m.set(a.projectId, a.projectTitle ?? a.projectId)
    return [...m.entries()].sort((x, y) => x[1].localeCompare(y[1]))
  }, [all])
  const shown = all.filter(
    (a) =>
      (project === "__all" || a.projectId === project) &&
      (!search.trim() ||
        `${a.title} ${a.file} ${a.projectTitle ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()))
  )
  const total = shown.reduce((s, a) => s + a.sizeBytes, 0)

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Artifacts
          </h1>
          <p className="text-sm text-muted-foreground">
            Every rendered video on disk
            {all.length
              ? ` · ${shown.length} of ${all.length} · ${formatBytes(total)}`
              : ""}
          </p>
        </div>
        <InputGroup className="w-64">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search titles"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search artifacts"
          />
        </InputGroup>
        <Select value={project} onValueChange={setProject}>
          <SelectTrigger className="w-64" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__all">All projects</SelectItem>
              {projects.map(([id, title]) => (
                <SelectItem key={id} value={id}>
                  {title}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {q.isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-[9/16]" />
          ))}
        </div>
      ) : shown.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
          {shown.map((a) => (
            <ArtifactCard key={a.path} a={a} />
          ))}
        </div>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>
              {all.length ? "Nothing matches" : "No renders on disk yet"}
            </EmptyTitle>
            <EmptyDescription>
              {all.length
                ? "Try another project or search."
                : "Rendered clips show up here to watch, download or open in their folder."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}
