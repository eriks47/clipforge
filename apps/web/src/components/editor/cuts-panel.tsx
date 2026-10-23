import { useMemo, useState } from "react"
import { wordIndicesInRange, type Cut } from "@clipforge/shared"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import {
  FieldGroup,
  FieldSeparator,
  FieldSet,
  FieldLegend,
  FieldDescription,
  Field,
  FieldLabel,
} from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SliderField, SwitchField } from "./fields"
import { patchSection, type PanelProps } from "./types"

/** Mini timeline of the clip: words, cuts (click to restore/re-apply) and the playhead. */
function CutsTimeline({
  ctx,
  plan,
  cfg,
  update,
  srcTime,
  seekSrc,
}: PanelProps) {
  const { start, end } = ctx.clip
  const len = Math.max(end - start, 1e-6)
  const pct = (t: number) => `${((t - start) / len) * 100}%`
  const words = ctx.transcript?.words ?? []
  const idx = wordIndicesInRange(words, { start, end })
  const toggleCut = (c: Cut) => {
    if (c.kind === "deleted") {
      const wi = Number(c.id.split(":")[1])
      patchSection(
        update,
        "cuts",
        { deletedWords: cfg.cuts.deletedWords.filter((w) => w !== wi) },
        "deleted"
      )
    } else {
      const restored = new Set(cfg.cuts.restoredCuts)
      if (restored.has(c.id)) restored.delete(c.id)
      else restored.add(c.id)
      patchSection(update, "cuts", { restoredCuts: [...restored] }, "restored")
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <div
        className="relative h-12 cursor-pointer border bg-muted"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          seekSrc(start + ((e.clientX - r.left) / r.width) * len)
        }}
      >
        {idx.map((i) => (
          <div
            key={i}
            className="absolute top-4 h-4 bg-muted-foreground/40"
            style={{
              left: pct(words[i].start),
              width: `max(1px, calc(${pct(words[i].end)} - ${pct(words[i].start)}))`,
            }}
          />
        ))}
        {plan.cuts.map((c) => (
          <Tooltip key={c.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCut(c)
                }}
                className={cn(
                  "absolute top-0 h-full border-x",
                  c.active
                    ? c.kind === "gap"
                      ? "border-destructive/60 bg-destructive/35"
                      : "border-chart-2 bg-chart-2/50"
                    : "border-dashed border-muted-foreground bg-transparent"
                )}
                style={{
                  left: pct(c.start),
                  width: `max(3px, calc(${pct(c.end)} - ${pct(c.start)}))`,
                }}
                aria-label={`${c.active ? "Restore" : "Re-apply"} cut: ${c.label}`}
              />
            </TooltipTrigger>
            <TooltipContent>
              {c.kind === "gap"
                ? "Dead air"
                : c.kind === "filler"
                  ? `Filler “${c.label}”`
                  : `Deleted “${c.label}”`}{" "}
              · {formatDuration(c.end - c.start)} — click to{" "}
              {c.active ? "restore" : "cut again"}
            </TooltipContent>
          </Tooltip>
        ))}
        <div
          className="pointer-events-none absolute top-0 h-full w-px bg-destructive"
          style={{ left: pct(srcTime) }}
        />
      </div>
      <div className="flex gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 bg-destructive/50" /> dead air
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 bg-chart-2/60" /> filler / deleted
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 border border-dashed border-muted-foreground" />{" "}
          restored
        </span>
        <span className="ml-auto">
          {plan.cuts.filter((c) => c.active).length} cuts ·{" "}
          {formatDuration(end - start)} → {formatDuration(plan.duration)}
        </span>
      </div>
    </div>
  )
}

/** Click words to strike them out (cut). */
function WordStrike({ ctx, cfg, update, plan, srcTime, seekSrc }: PanelProps) {
  const words = useMemo(() => ctx.transcript?.words ?? [], [ctx.transcript])
  const idx = useMemo(
    () =>
      wordIndicesInRange(words, { start: ctx.clip.start, end: ctx.clip.end }),
    [words, ctx.clip.start, ctx.clip.end]
  )
  const deleted = new Set(cfg.cuts.deletedWords)
  const fillerCut = useMemo(() => {
    const s = new Set<number>()
    for (const c of plan.cuts)
      if (c.kind === "filler" && c.active)
        for (const i of idx)
          if (words[i].start >= c.start - 0.01 && words[i].end <= c.end + 0.01)
            s.add(i)
    return s
  }, [plan.cuts, idx, words])
  if (!words.length)
    return (
      <p className="text-xs text-muted-foreground">
        No transcript for this clip.
      </p>
    )
  return (
    <p className="text-sm leading-7">
      {idx.map((i) => {
        const w = words[i]
        const isDel = deleted.has(i)
        const isFiller = fillerCut.has(i)
        const active = srcTime >= w.start && srcTime < w.end
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            onClick={(e) => {
              if (e.altKey) return seekSrc(w.start)
              const next = isDel
                ? cfg.cuts.deletedWords.filter((x) => x !== i)
                : [...cfg.cuts.deletedWords, i]
              patchSection(update, "cuts", { deletedWords: next }, "deleted")
            }}
            onDoubleClick={() => seekSrc(w.start)}
            className={cn(
              "cursor-pointer px-0.5 hover:bg-accent",
              (isDel || isFiller) &&
                "text-muted-foreground line-through decoration-destructive decoration-2",
              active && "bg-primary text-primary-foreground"
            )}
            title={
              isFiller
                ? "Auto-removed filler (restore it on the cut timeline)"
                : "Click to cut · double-click to seek"
            }
          >
            {w.text}{" "}
          </span>
        )
      })}
    </p>
  )
}

export function CutsPanel(props: PanelProps) {
  const { cfg, update } = props
  const [fillerText, setFillerText] = useState(
    cfg.cuts.fillers.words.join(", ")
  )
  return (
    <FieldGroup>
      <CutsTimeline {...props} />
      <FieldSet>
        <FieldLegend>Dead air</FieldLegend>
        <SwitchField
          label="Remove pauses between words"
          checked={cfg.cuts.deadAir.enabled}
          onChange={(v) =>
            patchSection(
              update,
              "cuts",
              { deadAir: { ...cfg.cuts.deadAir, enabled: v } },
              "deadAir.enabled"
            )
          }
        />
        <SliderField
          label="Minimum gap"
          value={cfg.cuts.deadAir.minGapMs}
          min={100}
          max={1500}
          step={10}
          format={(v) => `${v} ms`}
          disabled={!cfg.cuts.deadAir.enabled}
          onChange={(v) =>
            patchSection(
              update,
              "cuts",
              { deadAir: { ...cfg.cuts.deadAir, minGapMs: v } },
              "deadAir.minGap"
            )
          }
        />
        <SliderField
          label="Keep padding"
          value={cfg.cuts.deadAir.padMs}
          min={0}
          max={300}
          step={5}
          format={(v) => `${v} ms`}
          disabled={!cfg.cuts.deadAir.enabled}
          onChange={(v) =>
            patchSection(
              update,
              "cuts",
              { deadAir: { ...cfg.cuts.deadAir, padMs: v } },
              "deadAir.pad"
            )
          }
        />
        <SliderField
          label="Audio crossfade at cuts"
          value={cfg.cuts.crossfadeMs}
          min={0}
          max={80}
          step={5}
          format={(v) => `${v} ms`}
          onChange={(v) =>
            patchSection(update, "cuts", { crossfadeMs: v }, "crossfade")
          }
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Filler words</FieldLegend>
        <SwitchField
          label="Remove fillers"
          checked={cfg.cuts.fillers.enabled}
          onChange={(v) =>
            patchSection(
              update,
              "cuts",
              { fillers: { ...cfg.cuts.fillers, enabled: v } },
              "fillers.enabled"
            )
          }
        />
        <Field>
          <FieldLabel htmlFor="fillers">Filler list</FieldLabel>
          <Textarea
            id="fillers"
            rows={2}
            value={fillerText}
            onChange={(e) => setFillerText(e.target.value)}
            onBlur={() =>
              patchSection(
                update,
                "cuts",
                {
                  fillers: {
                    ...cfg.cuts.fillers,
                    words: fillerText
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                },
                "fillers.words"
              )
            }
          />
          <FieldDescription>
            Comma separated. “like”, “so”, “well”… are only cut when set off by
            commas.
          </FieldDescription>
        </Field>
        <SliderField
          label="Minimum confidence"
          value={cfg.cuts.fillers.minProb}
          min={0}
          max={1}
          step={0.05}
          format={(v) => v.toFixed(2)}
          disabled={!cfg.cuts.fillers.enabled}
          onChange={(v) =>
            patchSection(
              update,
              "cuts",
              { fillers: { ...cfg.cuts.fillers, minProb: v } },
              "fillers.minProb"
            )
          }
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Speed</FieldLegend>
        <SliderField
          label="Playback speed (pitch preserved)"
          value={cfg.speed}
          min={0.8}
          max={1.5}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update((c) => ({ ...c, speed: v }), "speed")}
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend className="flex items-center gap-2">
          Transcript{" "}
          <Badge variant="outline">{cfg.cuts.deletedWords.length} struck</Badge>
        </FieldLegend>
        <FieldDescription>
          Click words to cut them; double-click to jump there.
        </FieldDescription>
        <WordStrike {...props} />
      </FieldSet>
    </FieldGroup>
  )
}
