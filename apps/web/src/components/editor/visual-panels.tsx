import { useQuery } from "@tanstack/react-query"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  Delete02Icon,
  FaceIdIcon,
  Upload04Icon,
} from "@hugeicons/core-free-icons"
import {
  FRAMING_MODES,
  SAFE_ZONE_PLATFORMS,
  type FramingMode,
} from "@clipforge/shared"
import { api } from "@/lib/api"
import { formatTime } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import {
  FieldDescription,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field"
import {
  ColorField,
  SelectField,
  SliderField,
  SwitchField,
  TextField,
  ToggleField,
} from "./fields"
import { patchSection, type PanelProps } from "./types"

const MODE_LABELS: Record<FramingMode, string> = {
  "face-track": "Face track",
  center: "Center",
  manual: "Manual",
  split: "Split (2 speakers)",
  "blur-fill": "Blur fill",
}

export function FramingPanel(props: PanelProps) {
  const { cfg, update, ctx, jobs, srcTime } = props
  const f = cfg.framing
  const set = (v: Partial<typeof f>, key: string) =>
    patchSection(update, "framing", v, key)
  const facesJob = jobs
    .filter((j) => j.type === "faces" && j.clipId === ctx.clip.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const tracking =
    facesJob && (facesJob.status === "running" || facesJob.status === "queued")
  const track = useMutation({
    mutationFn: () => api.trackFaces(ctx.clip.id),
    onError: (e) => toast.error(e.message),
  })
  const needsFaces = f.mode === "face-track" || f.mode === "split"
  const facesFound = ctx.faces
    ? ctx.faces.samples.filter((s) => s.faces.length).length
    : 0

  return (
    <FieldGroup>
      <ToggleField
        label="Mode (16:9 → 9:16)"
        value={f.mode}
        options={FRAMING_MODES.map((m) => ({
          value: m,
          label: MODE_LABELS[m],
        }))}
        onChange={(v) => set({ mode: v }, "mode")}
      />
      {needsFaces ? (
        <FieldSet>
          <FieldLegend>Face tracking</FieldLegend>
          {tracking ? (
            <Alert>
              <HugeiconsIcon icon={FaceIdIcon} strokeWidth={2} />
              <AlertTitle>Detecting faces…</AlertTitle>
              <AlertDescription>
                The preview shows the full frame (blur fill) until faces are
                found, so it never crops into empty space.
              </AlertDescription>
            </Alert>
          ) : ctx.faces && facesFound > 0 ? (
            <FieldDescription>
              {ctx.faces.detector}: faces found in {facesFound} of{" "}
              {ctx.faces.samples.length} samples. Frames without a face hold the
              last framed person.
            </FieldDescription>
          ) : ctx.faces ? (
            <Alert variant="destructive">
              <HugeiconsIcon icon={FaceIdIcon} strokeWidth={2} />
              <AlertTitle>No faces found in this clip</AlertTitle>
              <AlertDescription>
                Showing the full frame (blur fill) instead of cropping blindly.
                Use Manual keyframes to pick a crop yourself.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert>
              <HugeiconsIcon icon={FaceIdIcon} strokeWidth={2} />
              <AlertTitle>No face data yet</AlertTitle>
              <AlertDescription>
                Detection starts automatically; the preview shows the full frame
                until then.
              </AlertDescription>
            </Alert>
          )}
          {tracking ? (
            <div className="flex items-center gap-2">
              <Spinner />
              <Progress value={facesJob.progress * 100} className="flex-1" />
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              onClick={() => track.mutate()}
            >
              <HugeiconsIcon
                icon={FaceIdIcon}
                strokeWidth={2}
                data-icon="inline-start"
              />
              {ctx.faces ? "Re-run detection" : "Detect faces"}
            </Button>
          )}
          {facesJob?.status === "failed" ? (
            <p className="text-xs text-destructive">{facesJob.error}</p>
          ) : null}
          <SliderField
            label="Smoothing"
            value={f.smoothing}
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => set({ smoothing: v }, "smoothing")}
          />
          <SliderField
            label="Speaker switch delay"
            value={f.switchMinSec}
            min={0.3}
            max={5}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            onChange={(v) => set({ switchMinSec: v }, "switchMin")}
          />
          <SliderField
            label="Switch ease"
            value={f.switchEaseSec}
            min={0.1}
            max={1.5}
            step={0.05}
            format={(v) => `${v.toFixed(2)}s`}
            onChange={(v) => set({ switchEaseSec: v }, "ease")}
          />
          <SliderField
            label="Hold through dropouts"
            value={f.holdDropoutSec}
            min={0}
            max={4}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            onChange={(v) => set({ holdDropoutSec: v }, "hold")}
          />
          <SliderField
            label="Sample every N frames"
            value={f.sampleEveryFrames}
            min={1}
            max={15}
            step={1}
            description="Changing this needs a new detection run."
            onChange={(v) => set({ sampleEveryFrames: v }, "every")}
          />
        </FieldSet>
      ) : null}
      {f.mode === "manual" ? (
        <FieldSet>
          <FieldLegend>Keyframes</FieldLegend>
          <FieldDescription>
            Position the frame at the playhead; keyframes are eased smoothly.
          </FieldDescription>
          <Button
            size="sm"
            variant="secondary"
            className="w-fit"
            onClick={() => {
              const prev = f.manualKeyframes.reduce<
                (typeof f.manualKeyframes)[number] | null
              >(
                (acc, k) => (k.t <= srcTime && (!acc || k.t > acc.t) ? k : acc),
                null
              )
              set(
                {
                  manualKeyframes: [
                    ...f.manualKeyframes.filter(
                      (k) => Math.abs(k.t - srcTime) > 0.05
                    ),
                    { t: srcTime, x: prev?.x ?? 0.5, y: 0.5 },
                  ].sort((a, b) => a.t - b.t),
                },
                "kf.add"
              )
            }}
          >
            <HugeiconsIcon
              icon={Add01Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            Add keyframe at {formatTime(srcTime, true)}
          </Button>
          {f.manualKeyframes.map((k, i) => (
            <div key={`${k.t}-${i}`} className="flex items-end gap-2">
              <Badge variant="outline" className="mb-1 font-mono">
                {formatTime(k.t, true)}
              </Badge>
              <div className="flex-1">
                <SliderField
                  label="Horizontal focus"
                  value={k.x}
                  min={0}
                  max={1}
                  step={0.005}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) =>
                    set(
                      {
                        manualKeyframes: f.manualKeyframes.map((x, j) =>
                          j === i ? { ...x, x: v } : x
                        ),
                      },
                      `kf.${i}`
                    )
                  }
                />
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Delete keyframe"
                onClick={() =>
                  set(
                    {
                      manualKeyframes: f.manualKeyframes.filter(
                        (_, j) => j !== i
                      ),
                    },
                    "kf.del"
                  )
                }
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </div>
          ))}
        </FieldSet>
      ) : null}
      {f.mode === "blur-fill" ? (
        <FieldSet>
          <FieldLegend>Blur fill</FieldLegend>
          <SliderField
            label="Background blur"
            value={f.blurAmount}
            min={0}
            max={100}
            step={1}
            format={(v) => `${v}px`}
            onChange={(v) => set({ blurAmount: v }, "blur")}
          />
          <SliderField
            label="Frame zoom"
            value={f.fillZoom}
            min={1}
            max={3}
            step={0.01}
            format={(v) => `${v.toFixed(2)}×`}
            description="Enlarges the sharp video over the blurred background; the sides get cropped."
            onChange={(v) => set({ fillZoom: v }, "fillZoom")}
          />
          <SliderField
            label="Move left / right"
            value={f.fillOffsetX}
            min={-1}
            max={1}
            step={0.005}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ fillOffsetX: v }, "fillOffsetX")}
          />
          <SliderField
            label="Move up / down"
            value={f.fillOffsetY}
            min={-0.5}
            max={0.5}
            step={0.005}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ fillOffsetY: v }, "fillOffsetY")}
          />
          {f.fillZoom !== 1 || f.fillOffsetX !== 0 || f.fillOffsetY !== 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="w-fit"
              onClick={() =>
                set(
                  { fillZoom: 1, fillOffsetX: 0, fillOffsetY: 0 },
                  "fill.reset"
                )
              }
            >
              Reset frame
            </Button>
          ) : null}
        </FieldSet>
      ) : null}
    </FieldGroup>
  )
}

export function ZoomPanel(props: PanelProps) {
  const { cfg, update, srcTime } = props
  const z = cfg.zooms
  const set = (v: Partial<typeof z>, key: string) =>
    patchSection(update, "zooms", v, key)
  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend>Auto punch-ins</FieldLegend>
        <SwitchField
          label="Enable"
          checked={z.auto.enabled}
          onChange={(v) =>
            set({ auto: { ...z.auto, enabled: v } }, "auto.enabled")
          }
        />
        <SliderField
          label="Intensity"
          value={z.auto.intensity}
          min={0.02}
          max={0.35}
          step={0.01}
          format={(v) => `+${Math.round(v * 100)}%`}
          disabled={!z.auto.enabled}
          onChange={(v) =>
            set({ auto: { ...z.auto, intensity: v } }, "auto.intensity")
          }
        />
        <SliderField
          label="Max per minute"
          value={z.auto.maxPerMinute}
          min={1}
          max={20}
          step={1}
          disabled={!z.auto.enabled}
          onChange={(v) =>
            set({ auto: { ...z.auto, maxPerMinute: v } }, "auto.max")
          }
        />
        <SwitchField
          label="On energy spikes"
          checked={z.auto.onSpikes}
          disabled={!z.auto.enabled}
          onChange={(v) =>
            set({ auto: { ...z.auto, onSpikes: v } }, "auto.spikes")
          }
        />
        <SwitchField
          label="On emphasis words"
          checked={z.auto.onEmphasis}
          disabled={!z.auto.enabled}
          onChange={(v) =>
            set({ auto: { ...z.auto, onEmphasis: v } }, "auto.emphasis")
          }
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Jump-cut punch</FieldLegend>
        <SwitchField
          label="Alternate zoom on every cut"
          description="Hides jump cuts by changing framing at each cut."
          checked={z.punchOnCuts}
          onChange={(v) => set({ punchOnCuts: v }, "punch")}
        />
        <SliderField
          label="Punch amount"
          value={z.punchAmount}
          min={0.02}
          max={0.2}
          step={0.01}
          format={(v) => `+${Math.round(v * 100)}%`}
          disabled={!z.punchOnCuts}
          onChange={(v) => set({ punchAmount: v }, "punchAmount")}
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Manual zooms</FieldLegend>
        <Button
          size="sm"
          variant="secondary"
          className="w-fit"
          onClick={() =>
            set(
              {
                manual: [
                  ...z.manual,
                  { t: srcTime, scale: 1.15, durationSec: 1.5 },
                ].sort((a, b) => a.t - b.t),
              },
              "manual.add"
            )
          }
        >
          <HugeiconsIcon
            icon={Add01Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          Add zoom at {formatTime(srcTime, true)}
        </Button>
        {z.manual.map((m, i) => (
          <div
            key={`${m.t}-${i}`}
            className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-2"
          >
            <Badge variant="outline" className="mb-1 font-mono">
              {formatTime(m.t, true)}
            </Badge>
            <SliderField
              label="Scale"
              value={m.scale}
              min={1.02}
              max={1.6}
              step={0.01}
              format={(v) => `${v.toFixed(2)}×`}
              onChange={(v) =>
                set(
                  {
                    manual: z.manual.map((x, j) =>
                      j === i ? { ...x, scale: v } : x
                    ),
                  },
                  `manual.${i}.s`
                )
              }
            />
            <SliderField
              label="Hold"
              value={m.durationSec}
              min={0.3}
              max={6}
              step={0.1}
              format={(v) => `${v.toFixed(1)}s`}
              onChange={(v) =>
                set(
                  {
                    manual: z.manual.map((x, j) =>
                      j === i ? { ...x, durationSec: v } : x
                    ),
                  },
                  `manual.${i}.d`
                )
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Delete zoom"
              onClick={() =>
                set(
                  { manual: z.manual.filter((_, j) => j !== i) },
                  "manual.del"
                )
              }
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </Button>
          </div>
        ))}
      </FieldSet>
    </FieldGroup>
  )
}

export function LookPanel({ cfg, update }: PanelProps) {
  const l = cfg.look
  const set = (v: Partial<typeof l>, key: string) =>
    patchSection(update, "look", v, key)
  return (
    <FieldGroup>
      <SliderField
        label="Saturation"
        value={l.saturation}
        min={0}
        max={2}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set({ saturation: v }, "sat")}
      />
      <SliderField
        label="Contrast"
        value={l.contrast}
        min={0.5}
        max={1.6}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set({ contrast: v }, "con")}
      />
      <SliderField
        label="Brightness"
        value={l.brightness}
        min={0.5}
        max={1.5}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set({ brightness: v }, "bri")}
      />
      <SliderField
        label="Vignette"
        value={l.vignette}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set({ vignette: v }, "vig")}
      />
      <SliderField
        label="Sharpen"
        value={l.sharpen}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set({ sharpen: v }, "sharp")}
      />
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() =>
          set(
            {
              saturation: 1,
              contrast: 1,
              brightness: 1,
              vignette: 0,
              sharpen: 0,
            },
            "reset"
          )
        }
      >
        Reset look
      </Button>
    </FieldGroup>
  )
}

export function ExtrasPanel({ cfg, update }: PanelProps) {
  const e = cfg.extras
  const set = (v: Partial<typeof e>, key: string) =>
    patchSection(update, "extras", v, key)
  const music = useQuery({ queryKey: ["music"], queryFn: api.music })
  const upload = useMutation({
    mutationFn: api.uploadMusic,
    onSuccess: (r) => {
      void music.refetch()
      set({ music: { ...e.music, file: r.name, enabled: true } }, "music.file")
    },
    onError: (err) => toast.error(err.message),
  })
  const fpsValue = String(cfg.output.fps) as "source" | "30" | "60"
  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend>Overlays</FieldLegend>
        <SwitchField
          label="Progress bar"
          checked={e.progressBar.enabled}
          onChange={(v) =>
            set({ progressBar: { ...e.progressBar, enabled: v } }, "pb")
          }
        />
        {e.progressBar.enabled ? (
          <ColorField
            label="Bar color"
            value={e.progressBar.color}
            onChange={(v) =>
              set({ progressBar: { ...e.progressBar, color: v } }, "pbc")
            }
          />
        ) : null}
        <SwitchField
          label="Watermark / handle"
          checked={e.watermark.enabled}
          onChange={(v) =>
            set({ watermark: { ...e.watermark, enabled: v } }, "wm")
          }
        />
        {e.watermark.enabled ? (
          <>
            <TextField
              label="Text"
              value={e.watermark.text}
              onChange={(v) =>
                set({ watermark: { ...e.watermark, text: v } }, "wmt")
              }
            />
            <SelectField
              label="Position"
              value={e.watermark.position}
              options={[
                { value: "top-left", label: "Top left" },
                { value: "top-right", label: "Top right" },
                { value: "bottom-left", label: "Bottom left" },
                { value: "bottom-right", label: "Bottom right" },
                { value: "center", label: "Center" },
              ]}
              onChange={(v) =>
                set({ watermark: { ...e.watermark, position: v } }, "wmp")
              }
            />
            <SliderField
              label="Opacity"
              value={e.watermark.opacity}
              min={0.1}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(v) =>
                set({ watermark: { ...e.watermark, opacity: v } }, "wmo")
              }
            />
          </>
        ) : null}
        <SwitchField
          label="Intro flash"
          checked={e.introFlash}
          onChange={(v) => set({ introFlash: v }, "flash")}
        />
        <SwitchField
          label="Safe-zone overlay (preview only)"
          checked={cfg.safeZones.enabled}
          onChange={(v) =>
            update(
              (c) => ({ ...c, safeZones: { ...c.safeZones, enabled: v } }),
              "safe.enabled"
            )
          }
        />
        {cfg.safeZones.enabled ? (
          <ToggleField
            label="Platform"
            value={cfg.safeZones.platform}
            options={SAFE_ZONE_PLATFORMS.map((p) => ({
              value: p,
              label:
                p === "shorts"
                  ? "YouTube Shorts"
                  : p === "tiktok"
                    ? "TikTok"
                    : "Reels",
            }))}
            onChange={(v) =>
              update(
                (c) => ({ ...c, safeZones: { ...c.safeZones, platform: v } }),
                "safe.platform"
              )
            }
          />
        ) : null}
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Background music</FieldLegend>
        <SwitchField
          label="Enable music"
          description="Auto-ducks under speech."
          checked={e.music.enabled}
          onChange={(v) =>
            set({ music: { ...e.music, enabled: v } }, "music.enabled")
          }
        />
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <SelectField
              label="Track"
              value={e.music.file || "__none"}
              options={[
                { value: "__none", label: "(none)" },
                ...(music.data ?? []).map((m) => ({ value: m, label: m })),
              ]}
              onChange={(v) =>
                set(
                  { music: { ...e.music, file: v === "__none" ? "" : v } },
                  "music.file"
                )
              }
            />
          </div>
          <Button size="sm" variant="outline" asChild>
            <label className="cursor-pointer">
              <HugeiconsIcon
                icon={Upload04Icon}
                strokeWidth={2}
                data-icon="inline-start"
              />
              Add
              <input
                type="file"
                accept="audio/*"
                hidden
                onChange={(ev) => {
                  const file = ev.target.files?.[0]
                  ev.target.value = ""
                  if (file) upload.mutate(file)
                }}
              />
            </label>
          </Button>
        </div>
        <SliderField
          label="Music volume"
          value={e.music.volume}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) =>
            set({ music: { ...e.music, volume: v } }, "music.vol")
          }
        />
        <SliderField
          label="Under speech"
          value={e.music.duckTo}
          min={0}
          max={0.5}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) =>
            set({ music: { ...e.music, duckTo: v } }, "music.duck")
          }
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Output</FieldLegend>
        <SwitchField
          label="Loudness normalize"
          description={`Two-pass loudnorm to ${cfg.audio.targetLufs} LUFS`}
          checked={cfg.audio.loudnorm}
          onChange={(v) =>
            update(
              (c) => ({ ...c, audio: { ...c.audio, loudnorm: v } }),
              "audio.loudnorm"
            )
          }
        />
        <SliderField
          label="Target loudness"
          value={cfg.audio.targetLufs}
          min={-24}
          max={-9}
          step={0.5}
          format={(v) => `${v} LUFS`}
          onChange={(v) =>
            update(
              (c) => ({ ...c, audio: { ...c.audio, targetLufs: v } }),
              "audio.target"
            )
          }
        />
        <ToggleField
          label="Frame rate"
          value={fpsValue}
          options={[
            { value: "source", label: "Match source (≤60)" },
            { value: "30", label: "30 fps" },
            { value: "60", label: "60 fps" },
          ]}
          onChange={(v) =>
            update(
              (c) => ({
                ...c,
                output: {
                  fps: v === "source" ? "source" : v === "30" ? 30 : 60,
                },
              }),
              "output.fps"
            )
          }
        />
      </FieldSet>
    </FieldGroup>
  )
}
