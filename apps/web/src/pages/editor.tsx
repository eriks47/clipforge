import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Player, type PlayerRef } from "@remotion/player"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
  Rocket01Icon,
  PaintBoardIcon,
  FolderOpenIcon,
  Download04Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { ShortClip } from "@clipforge/remotion"
import {
  buildClipRenderProps,
  outToSrc,
  snapToWord,
  srcToOut,
  type EditConfig,
  type Preset,
} from "@clipforge/shared"
import { api, fileUrl, proxyUrl, renderUrl, type ClipContext } from "@/lib/api"
import { formatDuration, formatEta, formatTime } from "@/lib/format"
import { useHistory } from "@/lib/history"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Switch } from "@/components/ui/switch"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CutsPanel } from "@/components/editor/cuts-panel"
import { CaptionsPanel, HookPanel } from "@/components/editor/captions-panel"
import {
  ExtrasPanel,
  FramingPanel,
  LookPanel,
  ZoomPanel,
} from "@/components/editor/visual-panels"
import { PublishPanel } from "@/components/editor/publish-panel"
import { EmojiRenderToggle } from "@/components/editor/emoji"
import type { PanelProps } from "@/components/editor/types"

/** Apply a preset's style while keeping this clip's content-specific edits. */
function applyPreset(cur: EditConfig, preset: EditConfig): EditConfig {
  return {
    ...preset,
    hook: {
      ...preset.hook,
      text: cur.hook.text,
      emojiPick: cur.hook.emojiPick,
    },
    cuts: {
      ...preset.cuts,
      deletedWords: cur.cuts.deletedWords,
      restoredCuts: cur.cuts.restoredCuts,
    },
    captions: {
      ...preset.captions,
      overrides: cur.captions.overrides,
      hiddenWords: cur.captions.hiddenWords,
      emojiPicks: cur.captions.emojiPicks,
    },
    framing: {
      ...preset.framing,
      manualKeyframes: cur.framing.manualKeyframes,
    },
    zooms: { ...preset.zooms, manual: cur.zooms.manual },
  }
}

function proxyDims(w: number, h: number) {
  const ph = Math.min(720, h)
  return { width: Math.round((w * ph) / h / 2) * 2, height: ph }
}

function RangeEditor({
  ctx,
  onChange,
}: {
  ctx: ClipContext
  onChange: (r: { start: number; end: number }) => void
}) {
  // remounted (via key) whenever the saved range changes
  const [s, setS] = useState(ctx.clip.start.toFixed(2))
  const [e, setE] = useState(ctx.clip.end.toFixed(2))
  const words = ctx.transcript?.words ?? []
  const commit = () => {
    const start = snapToWord(words, Number(s), "start")
    const end = snapToWord(words, Number(e), "end")
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1)
      return toast.error("Invalid range")
    if (start !== ctx.clip.start || end !== ctx.clip.end)
      onChange({ start, end })
  }
  return (
    <div className="flex items-center gap-1 font-mono text-xs">
      <Input
        className="h-7 w-20 font-mono"
        value={s}
        onChange={(x) => setS(x.target.value)}
        onBlur={commit}
        onKeyDown={(x) => x.key === "Enter" && commit()}
        aria-label="Clip start (s)"
      />
      <span className="text-muted-foreground">→</span>
      <Input
        className="h-7 w-20 font-mono"
        value={e}
        onChange={(x) => setE(x.target.value)}
        onBlur={commit}
        onKeyDown={(x) => x.key === "Enter" && commit()}
        aria-label="Clip end (s)"
      />
    </div>
  )
}

export function EditorPage() {
  const { id = "" } = useParams()
  const qc = useQueryClient()
  const ctxQ = useQuery({
    queryKey: ["clip-context", id],
    queryFn: () => api.clipContext(id),
  })
  const ctx = ctxQ.data
  const jobsQ = useQuery({
    queryKey: ["jobs", ctx?.project.id ?? ""],
    queryFn: () => api.projectJobs(ctx!.project.id),
    enabled: !!ctx,
  })
  const presets = useQuery({ queryKey: ["presets"], queryFn: api.presets })
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const hist = useHistory<EditConfig | null>(null)
  const cfg = hist.value
  const loadedFor = useRef<string | null>(null)

  useEffect(() => {
    if (ctx && loadedFor.current !== ctx.clip.id) {
      loadedFor.current = ctx.clip.id
      hist.reset(ctx.clip.editConfig)
    }
  }, [ctx, hist])

  // ---------- autosave ----------
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">(
    "saved"
  )
  const lastSaved = useRef<string>("")
  // Adopt edits made on the server (e.g. an emoji pick before rendering)
  // as an undoable step — but only when there are no unsaved local edits to clobber.
  const serverSeen = useRef<string>("")
  useEffect(() => {
    if (!ctx || !cfg) return
    const server = JSON.stringify(ctx.clip.editConfig)
    // only react to fresh server data, not to local edits re-running this effect
    if (server === serverSeen.current) return
    const first = serverSeen.current === ""
    serverSeen.current = server
    if (first || !lastSaved.current) return
    if (
      server === lastSaved.current ||
      JSON.stringify(cfg) !== lastSaved.current
    )
      return
    lastSaved.current = server
    hist.set(ctx.clip.editConfig)
    toast.info("Clip settings were updated on the server — Ctrl+Z to undo")
  }, [ctx, cfg, hist])
  useEffect(() => {
    if (!cfg || !ctx) return
    const json = JSON.stringify(cfg)
    if (!lastSaved.current) {
      lastSaved.current = JSON.stringify(ctx.clip.editConfig)
    }
    if (json === lastSaved.current) return
    setSaveState("dirty")
    const t = setTimeout(() => {
      setSaveState("saving")
      api
        .patchClip(ctx.clip.id, { editConfig: cfg })
        .then(() => {
          lastSaved.current = json
          setSaveState("saved")
        })
        .catch((e: unknown) => {
          setSaveState("dirty")
          toast.error(
            `Save failed: ${e instanceof Error ? e.message : String(e)}`
          )
        })
    }, 500)
    return () => clearTimeout(t)
  }, [cfg, ctx])

  // ---------- preview props (same builder as the renderer) ----------
  const props = useMemo(() => {
    if (!ctx || !cfg || !ctx.project.probe) return null
    const probe = ctx.project.probe
    return buildClipRenderProps({
      range: { start: ctx.clip.start, end: ctx.clip.end },
      config: cfg,
      transcript: ctx.transcript,
      analysis: ctx.audio,
      faces: ctx.faces,
      scenes: ctx.scenes,
      probe,
      video: {
        src: proxyUrl(ctx.project.id),
        fileOffset: 0,
        ...proxyDims(probe.width, probe.height),
      },
      musicSrc:
        cfg.extras.music.enabled && cfg.extras.music.file
          ? fileUrl(`music/${cfg.extras.music.file}`)
          : null,
      preview: true,
    })
  }, [ctx, cfg])
  const inputProps = useMemo(() => {
    if (!props) return null
    const { plan: _plan, ...rest } = props
    return rest
  }, [props])

  const player = useRef<PlayerRef>(null)
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const p = player.current
    if (!p) return
    const onFrame = (e: { detail: { frame: number } }) =>
      setFrame(e.detail.frame)
    p.addEventListener("frameupdate", onFrame)
    return () => p.removeEventListener("frameupdate", onFrame)
  }, [inputProps !== null]) // eslint-disable-line react-hooks/exhaustive-deps

  const fps = props?.fps ?? 30
  const outTime = frame / fps
  const srcTime = props ? outToSrc(props.plan.edl, outTime) : 0
  const seekSrc = useCallback(
    (t: number) => {
      if (!props) return
      const o = srcToOut(props.plan.edl, t, "next") ?? 0
      player.current?.seekTo(Math.round(o * fps))
    },
    [props, fps]
  )

  const update = useCallback<PanelProps["update"]>(
    (fn, key) => hist.set((c) => (c ? fn(c) : c), key),
    [hist]
  )

  // ---------- actions ----------
  const patchRange = useMutation({
    mutationFn: (r: { start: number; end: number }) => api.patchClip(id, r),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["clip-context", id] }),
    onError: (e) => toast.error(e.message),
  })
  const rename = useMutation({
    mutationFn: (name: string) => api.patchClip(id, { name }),
    onError: (e) => toast.error(e.message),
  })
  const render = useMutation({
    mutationFn: async () => {
      if (cfg) await api.patchClip(id, { editConfig: cfg })
      return api.renderClip(id)
    },
    onSuccess: () => toast.success("Render queued"),
    onError: (e) => toast.error(e.message),
  })
  const [presetDialog, setPresetDialog] = useState(false)
  const [presetName, setPresetName] = useState("")
  const [presetDefault, setPresetDefault] = useState(true)
  const savePreset = useMutation({
    mutationFn: () =>
      api.createPreset({
        name: presetName,
        config: cfg!,
        makeDefault: presetDefault,
      }),
    onSuccess: () => {
      setPresetDialog(false)
      setPresetName("")
      void qc.invalidateQueries({ queryKey: ["presets"] })
      void qc.invalidateQueries({ queryKey: ["settings"] })
      toast.success("Preset saved")
    },
    onError: (e) => toast.error(e.message),
  })

  if (ctxQ.isLoading || !ctx || !cfg || !props || !inputProps) {
    return (
      <div className="flex gap-4 p-6">
        <Skeleton className="aspect-[9/16] h-[70vh]" />
        <Skeleton className="h-[70vh] flex-1" />
      </div>
    )
  }

  const jobs = jobsQ.data ?? []
  const renderJob = jobs
    .filter((j) => j.type === "render" && j.clipId === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const rendering =
    renderJob &&
    (renderJob.status === "running" || renderJob.status === "queued")
  const panelProps: PanelProps = {
    cfg,
    update,
    ctx,
    plan: props.plan,
    outTime,
    srcTime,
    seekSrc,
    jobs,
  }
  const defaultPresetId = settings.data?.defaultPresetId ?? null
  const rendered = renderUrl(ctx.clip.renderPath)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/projects/${ctx.project.id}`} aria-label="Back to review">
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Link>
        </Button>
        <Input
          key={ctx.clip.id}
          defaultValue={ctx.clip.name}
          className="h-7 w-72 font-medium"
          aria-label="Clip name"
          onBlur={(e) =>
            e.target.value.trim() &&
            e.target.value !== ctx.clip.name &&
            rename.mutate(e.target.value.trim())
          }
        />
        <RangeEditor
          key={`${ctx.clip.start}-${ctx.clip.end}`}
          ctx={ctx}
          onChange={(r) => patchRange.mutate(r)}
        />
        <span className="font-mono text-xs text-muted-foreground">
          {formatDuration(ctx.clip.end - ctx.clip.start)} →{" "}
          {formatDuration(props.plan.duration)} @ {fps} fps
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="w-16 text-right text-xs text-muted-foreground">
            {saveState === "saved"
              ? "Saved"
              : saveState === "saving"
                ? "Saving…"
                : "Edited"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={hist.undo}
                disabled={!hist.canUndo}
                aria-label="Undo"
              >
                <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={2} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={hist.redo}
                disabled={!hist.canRedo}
                aria-label="Redo"
              >
                <HugeiconsIcon icon={ArrowTurnForwardIcon} strokeWidth={2} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <HugeiconsIcon
                  icon={PaintBoardIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                Presets
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Apply style</DropdownMenuLabel>
                {(presets.data ?? []).length === 0 ? (
                  <DropdownMenuItem disabled>No presets yet</DropdownMenuItem>
                ) : null}
                {(presets.data ?? []).map((p: Preset) => (
                  <DropdownMenuItem
                    key={p.id}
                    onSelect={() =>
                      hist.set((c) => (c ? applyPreset(c, p.config) : c))
                    }
                  >
                    {p.name}
                    {p.id === defaultPresetId ? (
                      <Badge variant="secondary" className="ml-auto">
                        default
                      </Badge>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => setPresetDialog(true)}>
                  Save current style as preset…
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {rendered ? (
            <>
              <Button variant="ghost" size="icon-sm" asChild>
                <a href={rendered} download aria-label="Download render">
                  <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void api.openClipFolder(id)}
                aria-label="Open folder"
              >
                <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={2} />
              </Button>
            </>
          ) : null}
          <EmojiRenderToggle cfg={cfg} update={update} />
          <Button
            size="sm"
            onClick={() => render.mutate()}
            disabled={!!rendering || render.isPending}
          >
            {rendering ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <HugeiconsIcon
                icon={Rocket01Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
            )}
            {ctx.clip.renderPath ? "Re-render" : "Render"}
          </Button>
        </div>
      </div>

      {rendering ? (
        <div className="flex items-center gap-3 border-b px-4 py-1.5">
          <StatusBadge status={renderJob.status} />
          <Progress value={renderJob.progress * 100} className="flex-1" />
          <span className="font-mono text-xs text-muted-foreground">
            {Math.round(renderJob.progress * 100)}%{" "}
            {formatEta(renderJob.progress, renderJob.startedAt) ?? ""}
          </span>
        </div>
      ) : renderJob?.status === "failed" ? (
        <div className="border-b px-4 py-1.5 text-xs text-destructive">
          Last render failed: {renderJob.error}
        </div>
      ) : ctx.clip.status === "rendered" ? (
        <div className="flex items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground">
          <HugeiconsIcon
            icon={Tick02Icon}
            strokeWidth={2}
            className="size-4 text-primary"
          />
          Rendered to <span className="font-mono">{ctx.clip.renderPath}</span>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col items-center gap-2 border-r bg-muted/30 p-4">
          <div className="aspect-[9/16] h-[calc(100svh-11rem)] max-w-[44vw] bg-black">
            <Player
              ref={player}
              component={ShortClip}
              inputProps={inputProps}
              durationInFrames={props.durationInFrames}
              fps={fps}
              compositionWidth={props.width}
              compositionHeight={props.height}
              style={{ width: "100%", height: "100%" }}
              controls
              loop
              clickToPlay
              doubleClickToFullscreen
              acknowledgeRemotionLicense
            />
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            out {formatTime(outTime, true)} · src {formatTime(srcTime, true)}
          </div>
        </div>

        <Tabs defaultValue="cuts" className="flex min-h-0 flex-col gap-0">
          <div className="border-b px-4 py-2">
            <TabsList>
              <TabsTrigger value="cuts">Cuts</TabsTrigger>
              <TabsTrigger value="captions">Captions</TabsTrigger>
              <TabsTrigger value="hook">Hook</TabsTrigger>
              <TabsTrigger value="framing">Framing</TabsTrigger>
              <TabsTrigger value="zoom">Zoom</TabsTrigger>
              <TabsTrigger value="look">Look</TabsTrigger>
              <TabsTrigger value="extras">Extras & output</TabsTrigger>
              <TabsTrigger value="publish">Publish</TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="max-w-2xl">
              <TabsContent value="cuts">
                <CutsPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="captions">
                <CaptionsPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="hook">
                <HookPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="framing">
                <FramingPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="zoom">
                <ZoomPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="look">
                <LookPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="extras">
                <ExtrasPanel {...panelProps} />
              </TabsContent>
              <TabsContent value="publish">
                <PublishPanel ctx={ctx} jobs={jobs} />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>

      <Dialog open={presetDialog} onOpenChange={setPresetDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save style preset</DialogTitle>
            <DialogDescription>
              Saves cuts, speed, captions, hook style, framing, zoom, look and
              extras — not this clip's hook text or word edits.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="preset-name">Name</FieldLabel>
              <Input
                id="preset-name"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="My style"
                autoFocus
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="preset-default">
                Use as default for new clips
              </FieldLabel>
              <Switch
                id="preset-default"
                checked={presetDefault}
                onCheckedChange={setPresetDefault}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPresetDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => savePreset.mutate()}
              disabled={!presetName.trim() || savePreset.isPending}
            >
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
