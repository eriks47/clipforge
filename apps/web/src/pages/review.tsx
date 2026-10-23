import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  PlayIcon,
  PauseIcon,
  RepeatIcon,
  Search01Icon,
  Add01Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
  WorkflowSquare03Icon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons"
import {
  buildMomentTracks,
  rangeText,
  snapToWord,
  wordIndicesInRange,
  type TimeRange,
} from "@clipforge/shared"
import { api, proxyUrl, type CandidateRow } from "@/lib/api"
import { formatDuration, formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Timeline } from "@/components/timeline"
import { CandidateCard } from "@/components/candidate-card"
import { PipelinePanel, latestJobs } from "@/components/pipeline-panel"
import { StatusBadge } from "@/components/status-badge"
import { PeoplePopover } from "@/components/people-popover"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Kbd } from "@/components/ui/kbd"
import { Toggle } from "@/components/ui/toggle"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["J / K / L", "Back 5 s / pause / play (press L again for faster)"],
  ["I / O", "Set in / out at playhead (Shift = no snapping)"],
  ["A / X", "Approve / reject selected"],
  ["↑ / ↓", "Previous / next candidate"],
  ["← / →", "Step 1 s (Shift = 5 s)"],
]

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  return (
    !!t &&
    (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
  )
}

export function ReviewPage() {
  const { id = "" } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const project = useQuery({
    queryKey: ["project", id],
    queryFn: () => api.project(id),
  })
  const jobs = useQuery({
    queryKey: ["jobs", id],
    queryFn: () => api.projectJobs(id),
  })
  const analysis = useQuery({
    queryKey: ["analysis", id],
    queryFn: () => api.analysis(id),
    staleTime: Infinity,
  })
  const cands = useQuery({
    queryKey: ["candidates", id],
    queryFn: () => api.candidates(id),
  })

  const video = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selection, setSelection] = useState<TimeRange | null>(null)
  const [view, setView] = useState<TimeRange | null>(null)
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [filter, setFilter] = useState<"all" | "new" | "approved" | "rejected">(
    "all"
  )
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  const duration = project.data?.probe?.duration ?? 0
  const moments = useMemo(
    () =>
      analysis.data
        ? buildMomentTracks(
            analysis.data.signals,
            analysis.data.visual,
            duration,
            analysis.data.audio?.hopSec ?? 0.5
          )
        : null,
    [analysis.data, duration]
  )
  const words = useMemo(
    () => analysis.data?.transcript?.words ?? [],
    [analysis.data]
  )
  const allCandidates = useMemo(() => cands.data ?? [], [cands.data])
  const visibleCandidates = useMemo(
    () => allCandidates.filter((c) => filter === "all" || c.status === filter),
    [allCandidates, filter]
  )
  const selected = allCandidates.find((c) => c.id === selectedId) ?? null
  const currentView = view ?? { start: 0, end: Math.max(duration, 1) }

  // playback clock + loop of the selected range
  const selRef = useRef(selection)
  const loopRef = useRef(loop)
  useEffect(() => {
    selRef.current = selection
    loopRef.current = loop
  }, [selection, loop])
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const v = video.current
      if (v) {
        const s = selRef.current
        if (s && loopRef.current && !v.paused && v.currentTime >= s.end)
          v.currentTime = s.start
        setTime(v.currentTime)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const seek = useCallback((t: number) => {
    const v = video.current
    if (v) v.currentTime = Math.max(0, t)
    setTime(t)
  }, [])
  const play = useCallback(
    () => void video.current?.play().catch(() => undefined),
    []
  )
  const pause = useCallback(() => video.current?.pause(), [])
  const toggle = useCallback(
    () => (video.current?.paused ? play() : pause()),
    [play, pause]
  )

  const patch = useMutation({
    mutationFn: ({
      cid,
      body,
    }: {
      cid: string
      body: Parameters<typeof api.patchCandidate>[1]
    }) => api.patchCandidate(cid, body),
    onSuccess: (r, vars) => {
      qc.setQueryData<CandidateRow[]>(["candidates", id], (l) =>
        l?.map((c) => (c.id === r.candidate.id ? r.candidate : c))
      )
      if (vars.body.status === "approved" && r.clip) {
        const clipId = r.clip.id
        toast.success("Approved — clip created", {
          action: {
            label: "Open editor",
            onClick: () => navigate(`/clips/${clipId}`),
          },
        })
      }
    },
    onError: (e) => toast.error(e.message),
  })
  const createManual = useMutation({
    mutationFn: (r: TimeRange) => api.manualCandidate(id, r),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["candidates", id] })
      setSelectedId(c.id)
      toast.success("Manual candidate created")
    },
    onError: (e) => toast.error(e.message),
  })
  const more = useMutation({
    mutationFn: () => api.moreCandidates(id),
    onSuccess: () => toast.success("Looking for more candidates…"),
    onError: (e) => toast.error(e.message),
  })

  const selectCandidate = useCallback(
    (c: CandidateRow | undefined, autoplay = true) => {
      if (!c) return
      setSelectedId(c.id)
      setSelection({ start: c.start, end: c.end })
      seek(c.start)
      if (autoplay) play()
      // bring the range into view
      setView((v) => {
        const len = v ? v.end - v.start : duration
        if (v && c.start >= v.start && c.end <= v.end) return v
        const pad = Math.max(10, (c.end - c.start) * 1.5)
        const want = Math.max(len, c.end - c.start + pad * 2)
        const start = Math.max(0, Math.min(duration - want, c.start - pad))
        return { start, end: Math.min(duration, start + want) }
      })
      cardRefs.current
        .get(c.id)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    },
    [seek, play, duration]
  )

  const commitSelection = useCallback(
    (r: TimeRange) => {
      setSelection(r)
      if (
        selected &&
        (Math.abs(r.start - selected.start) > 0.01 ||
          Math.abs(r.end - selected.end) > 0.01)
      ) {
        patch.mutate({ cid: selected.id, body: { start: r.start, end: r.end } })
      }
    },
    [selected, patch]
  )

  const setEdge = useCallback(
    (edge: "start" | "end", t: number, noSnap: boolean) => {
      const snapped = noSnap ? t : snapToWord(words, t, edge, 1.5)
      const base = selection ?? { start: t, end: Math.min(duration, t + 30) }
      const r =
        edge === "start"
          ? { start: Math.min(snapped, base.end - 1), end: base.end }
          : { start: base.start, end: Math.max(snapped, base.start + 1) }
      commitSelection(r)
    },
    [words, selection, duration, commitSelection]
  )

  const setStatus = useCallback(
    (c: CandidateRow, status: CandidateRow["status"]) =>
      patch.mutate({
        cid: c.id,
        body: {
          status: c.status === status && status === "rejected" ? "new" : status,
        },
      }),
    [patch]
  )

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return
      const v = video.current
      const k = e.key.toLowerCase()
      const idx = visibleCandidates.findIndex((c) => c.id === selectedId)
      if (e.key === " ") {
        e.preventDefault()
        toggle()
      } else if (k === "k") pause()
      else if (k === "j") {
        seek((v?.currentTime ?? 0) - 5)
      } else if (k === "l") {
        if (!v) return
        if (v.paused) {
          v.playbackRate = 1
          setRate(1)
          play()
        } else {
          const next = Math.min(v.playbackRate * 1.5, 4)
          v.playbackRate = next
          setRate(next)
        }
      } else if (k === "i") setEdge("start", v?.currentTime ?? 0, e.shiftKey)
      else if (k === "o") setEdge("end", v?.currentTime ?? 0, e.shiftKey)
      else if (k === "a" && selected) setStatus(selected, "approved")
      else if (k === "x" && selected) setStatus(selected, "rejected")
      else if (e.key === "ArrowDown") {
        e.preventDefault()
        selectCandidate(
          visibleCandidates[Math.min(visibleCandidates.length - 1, idx + 1)]
        )
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        selectCandidate(visibleCandidates[Math.max(0, idx - 1)])
      } else if (e.key === "ArrowRight")
        seek((v?.currentTime ?? 0) + (e.shiftKey ? 5 : 1))
      else if (e.key === "ArrowLeft")
        seek((v?.currentTime ?? 0) - (e.shiftKey ? 5 : 1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    toggle,
    pause,
    play,
    seek,
    setEdge,
    selected,
    setStatus,
    selectCandidate,
    visibleCandidates,
    selectedId,
  ])

  const latest = latestJobs(jobs.data ?? [])
  const pipelineBusy = latest.some(
    (j) => j.status === "running" || j.status === "queued"
  )
  const pipelineFailed = latest.some((j) => j.status === "failed")
  const excerpts = useMemo(() => {
    const t = analysis.data?.transcript ?? null
    return new Map(allCandidates.map((c) => [c.id, rangeText(t, c).text]))
  }, [allCandidates, analysis.data])

  const rangeWordIdx = useMemo(() => {
    if (!selection) return []
    return wordIndicesInRange(words, {
      start: selection.start - 4,
      end: selection.end + 4,
    })
  }, [selection, words])

  const zoom = (factor: number) => {
    const v = currentView
    const center =
      time >= v.start && time <= v.end ? time : (v.start + v.end) / 2
    const len = Math.max(5, Math.min(duration, (v.end - v.start) * factor))
    const start = Math.max(0, Math.min(duration - len, center - len / 2))
    setView({ start, end: start + len })
  }

  if (project.isLoading) return <Skeleton className="m-6 h-96" />
  if (!project.data)
    return <div className="p-6 text-sm">Project not found.</div>
  const p = project.data

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to="/" aria-label="Back to projects">
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Link>
        </Button>
        <h1 className="truncate font-heading text-sm font-semibold">
          {p.title}
        </h1>
        <StatusBadge status={p.status} />
        {p.probe ? (
          <span className="font-mono text-xs text-muted-foreground">
            {formatTime(p.probe.duration)} · {p.probe.width}×{p.probe.height} ·{" "}
            {p.probe.fps.toFixed(2)} fps
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <PeoplePopover project={p} />
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm">
                <HugeiconsIcon
                  icon={KeyboardIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                Shortcuts
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <div className="flex flex-col gap-1.5">
                {SHORTCUTS.map(([k, d]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between gap-4 text-xs"
                  >
                    <Kbd>{k}</Kbd>
                    <span className="text-muted-foreground">{d}</span>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPipelineOpen(true)}
          >
            {pipelineBusy ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <HugeiconsIcon
                icon={WorkflowSquare03Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
            )}
            Pipeline
            {pipelineFailed ? (
              <Badge variant="destructive">failed</Badge>
            ) : null}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/renders">Render queue</Link>
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          {pipelineBusy || pipelineFailed ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Analysis pipeline</CardTitle>
                <CardDescription>
                  Each step is cached; failed steps can be retried or skipped.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PipelinePanel jobs={jobs.data ?? []} projectId={id} />
              </CardContent>
            </Card>
          ) : null}

          <div className="flex justify-center bg-black">
            {p.hasProxy ? (
              <video
                ref={video}
                src={proxyUrl(p.id)}
                className="max-h-[52vh] w-full object-contain"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={toggle}
                preload="auto"
              />
            ) : (
              <div className="flex aspect-video max-h-[52vh] w-full items-center justify-center text-xs text-muted-foreground">
                <Spinner data-icon="inline-start" /> Generating preview proxy…
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              onClick={toggle}
              aria-label={playing ? "Pause" : "Play"}
            >
              <HugeiconsIcon
                icon={playing ? PauseIcon : PlayIcon}
                strokeWidth={2}
              />
            </Button>
            <span className="w-36 font-mono text-xs tabular-nums">
              {formatTime(time, true)} / {formatTime(duration)}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="sm"
                  pressed={loop}
                  onPressedChange={setLoop}
                  aria-label="Loop selection"
                >
                  <HugeiconsIcon icon={RepeatIcon} strokeWidth={2} />
                  Loop
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>Loop the selected range</TooltipContent>
            </Tooltip>
            <Select
              value={String(rate)}
              onValueChange={(v) => {
                const r = Number(v)
                setRate(r)
                if (video.current) video.current.playbackRate = r
              }}
            >
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[0.5, 1, 1.25, 1.5, 2, 3].map((r) => (
                    <SelectItem key={r} value={String(r)}>
                      {r}×
                    </SelectItem>
                  ))}
                  {![0.5, 1, 1.25, 1.5, 2, 3].includes(rate) ? (
                    <SelectItem value={String(rate)}>
                      {rate.toFixed(2)}×
                    </SelectItem>
                  ) : null}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selection ? (
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                IN {formatTime(selection.start, true)} · OUT{" "}
                {formatTime(selection.end, true)} ·{" "}
                {formatDuration(selection.end - selection.start)}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              {selection && !selected ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => createManual.mutate(selection)}
                  disabled={createManual.isPending}
                >
                  <HugeiconsIcon
                    icon={Add01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  Create candidate
                </Button>
              ) : null}
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => zoom(0.5)}
                aria-label="Zoom in"
              >
                <HugeiconsIcon icon={ZoomInAreaIcon} strokeWidth={2} />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => zoom(2)}
                aria-label="Zoom out"
              >
                <HugeiconsIcon icon={ZoomOutAreaIcon} strokeWidth={2} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setView({ start: 0, end: duration })}
              >
                Fit
              </Button>
            </div>
          </div>

          {duration > 0 ? (
            <Timeline
              duration={duration}
              currentTime={time}
              audio={analysis.data?.audio ?? null}
              heatmap={analysis.data?.heatmap ?? null}
              chat={analysis.data?.chat ?? null}
              moments={moments}
              scenes={analysis.data?.scenes ?? null}
              words={words}
              candidates={allCandidates.map((c) => ({
                id: c.id,
                start: c.start,
                end: c.end,
                rating: c.finalRating,
                status: c.status,
              }))}
              selectedId={selectedId}
              selection={selection}
              view={currentView}
              onViewChange={setView}
              onSeek={seek}
              onSelectCandidate={(cid) =>
                selectCandidate(
                  allCandidates.find((c) => c.id === cid),
                  false
                )
              }
              onSelectionChange={(r, final, kind) => {
                // a brand-new range detaches from the selected candidate (becomes a manual selection)
                if (kind === "create") {
                  setSelectedId(null)
                  setSelection(r)
                } else if (final) commitSelection(r)
                else setSelection(r)
              }}
            />
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Click to seek · drag in the bottom lane to select a new range · drag
            the handles to trim (snaps to words, hold <Kbd>Shift</Kbd> to
            disable) · scroll to zoom, <Kbd>Shift</Kbd>+scroll or <Kbd>Alt</Kbd>
            +drag to pan
          </p>

          {selection && words.length ? (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Transcript</CardTitle>
                <CardDescription>
                  Click a word to set IN, right-click to set OUT.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-7">
                  {rangeWordIdx.map((i) => {
                    const w = words[i]
                    const inside =
                      w.start >= selection.start - 0.01 &&
                      w.end <= selection.end + 0.01
                    const active = time >= w.start && time < w.end
                    return (
                      <span
                        key={i}
                        onClick={() =>
                          commitSelection({
                            start: Math.max(0, w.start - 0.05),
                            end: Math.max(selection.end, w.start + 1),
                          })
                        }
                        onContextMenu={(e) => {
                          e.preventDefault()
                          commitSelection({
                            start: Math.min(selection.start, w.end - 1),
                            end: w.end + 0.05,
                          })
                        }}
                        className={cn(
                          "cursor-pointer px-0.5 hover:bg-accent",
                          !inside && "text-muted-foreground/50",
                          active && "bg-primary text-primary-foreground",
                          w.prob < 0.5 &&
                            "underline decoration-destructive decoration-dotted"
                        )}
                        title={`${formatTime(w.start, true)} · p=${w.prob.toFixed(2)}`}
                      >
                        {w.text}{" "}
                      </span>
                    )
                  })}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <aside className="flex min-h-0 flex-col border-l">
          <div className="flex items-center gap-2 border-b p-3">
            <span className="text-xs font-semibold">Candidates</span>
            <Badge variant="secondary">{allCandidates.length}</Badge>
            <Select
              value={filter}
              onValueChange={(v) => setFilter(v as typeof filter)}
            >
              <SelectTrigger size="sm" className="ml-auto w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => more.mutate()}
              disabled={more.isPending || pipelineBusy}
            >
              <HugeiconsIcon
                icon={Search01Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
              Find more
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {cands.isLoading ? (
              Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-32" />
              ))
            ) : visibleCandidates.length ? (
              visibleCandidates.map((c) => (
                <CandidateCard
                  key={c.id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(c.id, el)
                    else cardRefs.current.delete(c.id)
                  }}
                  c={c}
                  selected={c.id === selectedId}
                  excerpt={excerpts.get(c.id) ?? ""}
                  onSelect={() => selectCandidate(c)}
                  onApprove={() => setStatus(c, "approved")}
                  onReject={() => setStatus(c, "rejected")}
                />
              ))
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>
                    {pipelineBusy ? "Analyzing…" : "No candidates"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {pipelineBusy
                      ? "Candidates appear once transcription and analysis finish."
                      : "Select a range on the timeline to create one manually, or try Find more."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </aside>
      </div>

      <Sheet open={pipelineOpen} onOpenChange={setPipelineOpen}>
        <SheetContent className="w-[640px] sm:max-w-[640px]">
          <SheetHeader>
            <SheetTitle>Pipeline</SheetTitle>
            <SheetDescription>
              Per-step status and logs. Re-running a step clears its cached
              output.
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">
            <PipelinePanel jobs={jobs.data ?? []} projectId={id} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
