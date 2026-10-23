import { useRef, useState, type DragEvent } from "react"
import { Link } from "react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  CloudUploadIcon,
  Delete02Icon,
  Link01Icon,
  MoreHorizontalIcon,
  Video01Icon,
  FolderOpenIcon,
  ArrowReloadHorizontalIcon,
} from "@hugeicons/core-free-icons"
import type { ProjectListItem } from "@clipforge/shared"
import { api, thumbUrl } from "@/lib/api"
import { formatBytes, formatRelative, formatTime } from "@/lib/format"
import { uploadFile } from "@/lib/upload"
import { cn } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface ActiveUpload {
  projectId: string
  name: string
  loaded: number
  total: number
  abort: AbortController
}

const ACCEPT = ".mp4,.webm,.mkv,.mov,.m4v,video/mp4,video/webm"

function useUploads() {
  const qc = useQueryClient()
  const [uploads, setUploads] = useState<Record<string, ActiveUpload>>({})

  const start = async (file: File, existingProjectId?: string) => {
    let projectId = existingProjectId
    try {
      if (!projectId) {
        const p = await api.createProject({
          title: file.name.replace(/\.[^.]+$/, ""),
          filename: file.name,
          size: file.size,
        })
        projectId = p.id
        void qc.invalidateQueries({ queryKey: ["projects"] })
      }
      const id = projectId
      const abort = new AbortController()
      setUploads((u) => ({
        ...u,
        [id]: {
          projectId: id,
          name: file.name,
          loaded: 0,
          total: file.size,
          abort,
        },
      }))
      await uploadFile(
        id,
        file,
        (p) =>
          setUploads((u) =>
            u[id] ? { ...u, [id]: { ...u[id], loaded: p.loaded } } : u
          ),
        abort.signal
      )
      toast.success(`Uploaded ${file.name} — analysis started`)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        toast.error(
          `Upload failed: ${e instanceof Error ? e.message : String(e)}`
        )
    } finally {
      if (projectId) {
        const id = projectId
        setUploads((u) => {
          const next = { ...u }
          delete next[id]
          return next
        })
      }
      void qc.invalidateQueries({ queryKey: ["projects"] })
    }
  }
  return { uploads, start }
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const files = [...e.dataTransfer.files].filter((f) =>
      /\.(mp4|webm|mkv|mov|m4v)$/i.test(f.name)
    )
    if (files.length) onFiles(files)
    else toast.error("Drop an mp4 or webm video")
  }
  return (
    <button
      type="button"
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => input.current?.click()}
      className={cn(
        "flex h-36 w-full flex-col items-center justify-center gap-2 border border-dashed text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground",
        over && "border-primary bg-primary/5 text-foreground"
      )}
    >
      <HugeiconsIcon
        icon={CloudUploadIcon}
        strokeWidth={1.5}
        className="size-8"
      />
      <span className="font-medium text-foreground">
        Drop a long video here
      </span>
      <span className="text-xs">
        mp4 / webm, any size — uploads resume if interrupted
      </span>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ""
          if (files.length) onFiles(files)
        }}
      />
    </button>
  )
}

function UrlImport() {
  const qc = useQueryClient()
  const [url, setUrl] = useState("")
  const m = useMutation({
    mutationFn: api.importUrl,
    onSuccess: () => {
      setUrl("")
      toast.success("Download queued")
      void qc.invalidateQueries({ queryKey: ["projects"] })
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim()) m.mutate(url.trim())
      }}
    >
      <InputGroup>
        <InputGroupAddon>
          <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="…or paste a YouTube or Twitch VOD URL (YouTube adds the 'most replayed' heatmap, Twitch adds chat activity)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            type="submit"
            variant="secondary"
            disabled={!url.trim() || m.isPending}
          >
            Import
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

function ProjectCard({
  p,
  upload,
  onResume,
  onDelete,
}: {
  p: ProjectListItem
  upload?: ActiveUpload
  onResume: () => void
  onDelete: () => void
}) {
  const [thumbOk, setThumbOk] = useState(true)
  const uploadPct = upload
    ? (upload.loaded / upload.total) * 100
    : p.sizeBytes
      ? (p.uploadedBytes / p.sizeBytes) * 100
      : 0
  const open = p.status !== "uploading"
  const body = (
    <>
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {p.hasThumbnail && thumbOk ? (
          <img
            src={thumbUrl(p.id)}
            alt=""
            className="size-full object-cover"
            onError={() => setThumbOk(false)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <HugeiconsIcon
              icon={Video01Icon}
              strokeWidth={1.5}
              className="size-10"
            />
          </div>
        )}
        {p.probe ? (
          <span className="absolute right-2 bottom-2 bg-background/85 px-1.5 py-0.5 font-mono text-xs">
            {formatTime(p.probe.duration)}
          </span>
        ) : null}
      </div>
    </>
  )
  return (
    <Card className="gap-0 overflow-hidden py-0">
      {open ? (
        <Link to={`/projects/${p.id}`} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
      <CardHeader className="py-3">
        <CardTitle className="truncate">
          {open ? (
            <Link to={`/projects/${p.id}`} className="hover:underline">
              {p.title}
            </Link>
          ) : (
            p.title
          )}
        </CardTitle>
        <CardDescription className="flex items-center gap-2">
          <StatusBadge status={p.status} />
          <span>{formatRelative(p.createdAt)}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-3">
        {p.status === "uploading" ? (
          <div className="flex flex-col gap-1.5">
            <Progress value={uploadPct} />
            <span className="text-xs text-muted-foreground">
              {formatBytes(upload?.loaded ?? p.uploadedBytes)} /{" "}
              {formatBytes(p.sizeBytes)}
            </span>
          </div>
        ) : (
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">
                {p.candidateCount}
              </span>{" "}
              candidates
            </span>
            <span>
              <span className="font-medium text-foreground">
                {p.renderedCount}
              </span>{" "}
              rendered
            </span>
            {p.probe ? (
              <span>
                {p.probe.width}×{p.probe.height}
              </span>
            ) : null}
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-between border-t py-2">
        {p.status === "uploading" && !upload ? (
          <Button size="sm" variant="secondary" onClick={onResume}>
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            Resume upload
          </Button>
        ) : upload ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => upload.abort.abort()}
          >
            Pause
          </Button>
        ) : (
          <Button size="sm" variant="ghost" asChild>
            <Link to={`/projects/${p.id}`}>Open review</Link>
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Project actions">
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => void api.openProjectFolder(p.id)}
              >
                <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
                Open folder
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Delete project
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardFooter>
    </Card>
  )
}

export function ProjectsPage() {
  const qc = useQueryClient()
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: 15_000,
  })
  const { uploads, start } = useUploads()
  const [toDelete, setToDelete] = useState<ProjectListItem | null>(null)
  const resumeInput = useRef<HTMLInputElement>(null)
  const [resumeTarget, setResumeTarget] = useState<ProjectListItem | null>(null)
  const del = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: () => {
      toast.success("Project deleted")
      void qc.invalidateQueries({ queryKey: ["projects"] })
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Projects
          </h1>
          <p className="text-sm text-muted-foreground">
            Upload a long video; ClipForge transcribes, analyzes and proposes
            ranked Shorts.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <DropZone onFiles={(files) => files.forEach((f) => void start(f))} />
        <UrlImport />
      </div>

      {projects.isLoading ? (
        <div className="grid grid-cols-3 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[4/3]" />
          ))}
        </div>
      ) : projects.data && projects.data.length > 0 ? (
        <div className="grid grid-cols-3 gap-4 xl:grid-cols-4">
          {projects.data.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              upload={uploads[p.id]}
              onDelete={() => setToDelete(p)}
              onResume={() => {
                setResumeTarget(p)
                resumeInput.current?.click()
              }}
            />
          ))}
        </div>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={Video01Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Drop a podcast, stream VOD or interview above to get started.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <input
        ref={resumeInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (!f || !resumeTarget) return
          if (f.size !== resumeTarget.sizeBytes) {
            toast.error(
              `That file is ${formatBytes(f.size)}, expected ${formatBytes(resumeTarget.sizeBytes)}. Pick the same file.`
            )
            return
          }
          void start(f, resumeTarget.id)
        }}
      />

      <AlertDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{toDelete?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the project folder with the source video, analysis,
              candidates and rendered clips. Files copied to your export
              directory are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (toDelete) del.mutate(toDelete.id)
                setToDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
