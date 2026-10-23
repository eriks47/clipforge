import { useMemo, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  SparklesIcon,
  ViewOffIcon,
  ArrowTurnBackwardIcon,
} from "@hugeicons/core-free-icons"
import {
  applyCaptionPreset,
  CAPTION_PRESETS,
  FONT_WEIGHTS,
  FONTS,
  resolveFontWeight,
  wordIndicesInRange,
  type CaptionPreset,
  type FontName,
} from "@clipforge/shared"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  ColorField,
  SelectField,
  SliderField,
  SwitchField,
  ToggleField,
} from "./fields"
import { patchSection, type PanelProps } from "./types"
import { CaptionEmojiFields, HookEmojiFields } from "./emoji"

const FONT_OPTIONS = FONTS.map((f) => ({ value: f, label: f }))
const WEIGHT_LABELS: Record<number, string> = {
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extrabold",
  900: "Black",
}
const PRESET_LABELS: Record<CaptionPreset, string> = {
  bold: "Bold stroke",
  highlight: "Yellow highlight",
  boxed: "Boxed",
  minimal: "Minimal",
}

/** Fix Whisper mistakes without changing timing; hide individual words. */
function CaptionWordEditor({ ctx, cfg, update, srcTime }: PanelProps) {
  const words = useMemo(() => ctx.transcript?.words ?? [], [ctx.transcript])
  const idx = useMemo(
    () =>
      wordIndicesInRange(words, { start: ctx.clip.start, end: ctx.clip.end }),
    [words, ctx.clip.start, ctx.clip.end]
  )
  const [editing, setEditing] = useState<number | null>(null)
  const hidden = new Set(cfg.captions.hiddenWords)
  const deleted = new Set(cfg.cuts.deletedWords)
  const overrides = cfg.captions.overrides
  const setOverride = (i: number, text: string | null) => {
    const next = { ...overrides }
    if (text === null || text === words[i].text) delete next[String(i)]
    else next[String(i)] = text
    patchSection(update, "captions", { overrides: next }, `override.${i}`)
  }
  const toggleHidden = (i: number) =>
    patchSection(
      update,
      "captions",
      {
        hiddenWords: hidden.has(i)
          ? cfg.captions.hiddenWords.filter((x) => x !== i)
          : [...cfg.captions.hiddenWords, i],
      },
      "hidden"
    )

  return (
    <div className="flex flex-col gap-2">
      {editing !== null ? (
        <InputGroup>
          <InputGroupInput
            autoFocus
            value={overrides[String(editing)] ?? words[editing].text}
            onChange={(e) => setOverride(editing, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setEditing(null)}
            aria-label="Caption text for word"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton onClick={() => toggleHidden(editing)}>
              <HugeiconsIcon icon={ViewOffIcon} strokeWidth={2} />
              {hidden.has(editing) ? "Show" : "Hide"}
            </InputGroupButton>
            <InputGroupButton onClick={() => setOverride(editing, null)}>
              <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={2} />
              Reset
            </InputGroupButton>
            <InputGroupButton
              variant="secondary"
              onClick={() => setEditing(null)}
            >
              Done
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      ) : null}
      <p className="text-sm leading-7">
        {idx.map((i) => {
          const w = words[i]
          const text = overrides[String(i)] ?? w.text
          return (
            <span
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => setEditing(i)}
              className={cn(
                "cursor-pointer px-0.5 hover:bg-accent",
                overrides[String(i)] !== undefined &&
                  "underline decoration-primary decoration-2",
                hidden.has(i) && "text-muted-foreground/50 italic",
                deleted.has(i) && "line-through opacity-40",
                editing === i && "bg-accent",
                srcTime >= w.start &&
                  srcTime < w.end &&
                  "bg-primary text-primary-foreground"
              )}
            >
              {text}{" "}
            </span>
          )
        })}
      </p>
    </div>
  )
}

export function CaptionsPanel(props: PanelProps) {
  const { cfg, update } = props
  const c = cfg.captions
  const set = (v: Partial<typeof c>, key: string) =>
    patchSection(update, "captions", v, key)
  return (
    <FieldGroup>
      <SwitchField
        label="Show captions"
        checked={c.enabled}
        onChange={(v) => set({ enabled: v }, "enabled")}
      />
      <ToggleField
        label="Style preset"
        value={c.preset}
        options={CAPTION_PRESETS.map((p) => ({
          value: p,
          label: PRESET_LABELS[p],
        }))}
        onChange={(p) =>
          update((cur) => applyCaptionPreset(cur, p), "captions.preset")
        }
      />
      <ToggleField
        label="Grouping"
        value={c.mode}
        options={[
          { value: "phrase", label: "Phrase" },
          { value: "word", label: "Word by word" },
        ]}
        onChange={(v) => set({ mode: v }, "mode")}
      />
      {c.mode === "phrase" ? (
        <div className="grid grid-cols-2 gap-4">
          <SliderField
            label="Max words / page"
            value={c.maxWords}
            min={1}
            max={8}
            step={1}
            onChange={(v) => set({ maxWords: v }, "maxWords")}
          />
          <SliderField
            label="Max characters"
            value={c.maxChars}
            min={6}
            max={40}
            step={1}
            onChange={(v) => set({ maxChars: v }, "maxChars")}
          />
        </div>
      ) : null}
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Look</FieldLegend>
        <SelectField
          label="Font"
          value={c.font}
          options={FONT_OPTIONS}
          onChange={(v: FontName) => set({ font: v }, "font")}
        />
        <SliderField
          label="Size"
          value={c.fontSize}
          min={36}
          max={140}
          step={1}
          format={(v) => `${v}px`}
          onChange={(v) => set({ fontSize: v }, "fontSize")}
        />
        <SliderField
          label="Vertical position"
          value={c.position}
          min={0.1}
          max={0.92}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ position: v }, "position")}
        />
        <ColorField
          label="Text color"
          value={c.color}
          onChange={(v) => set({ color: v }, "color")}
        />
        <ColorField
          label="Active word color"
          value={c.highlightColor}
          onChange={(v) => set({ highlightColor: v }, "highlight")}
        />
        {c.preset === "boxed" ? (
          <ColorField
            label="Box color"
            value={c.boxColor}
            onChange={(v) => set({ boxColor: v }, "box")}
          />
        ) : (
          <>
            <ColorField
              label="Stroke color"
              value={c.strokeColor}
              onChange={(v) => set({ strokeColor: v }, "strokeColor")}
            />
            <SliderField
              label="Stroke width"
              value={c.strokeWidth}
              min={0}
              max={24}
              step={1}
              format={(v) => `${v}px`}
              onChange={(v) => set({ strokeWidth: v }, "strokeWidth")}
            />
          </>
        )}
        <SwitchField
          label="UPPERCASE"
          checked={c.uppercase}
          onChange={(v) => set({ uppercase: v }, "uppercase")}
        />
        <SwitchField
          label="Pop-in animation"
          checked={c.animation === "pop"}
          onChange={(v) => set({ animation: v ? "pop" : "none" }, "animation")}
        />
      </FieldSet>
      <FieldSeparator />
      <CaptionEmojiFields {...props} />
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Caption text</FieldLegend>
        <FieldDescription>
          Click a word to fix its text (timing is kept) or hide it from
          captions.
        </FieldDescription>
        <CaptionWordEditor {...props} />
      </FieldSet>
    </FieldGroup>
  )
}

export function HookPanel(props: PanelProps) {
  const { cfg, update, ctx } = props
  const h = cfg.hook
  const set = (v: Partial<typeof h>, key: string) =>
    patchSection(update, "hook", v, key)
  const [alts, setAlts] = useState<string[]>([])
  const gen = useMutation({
    mutationFn: () => api.hookAlternatives(ctx.clip.id),
    onSuccess: (r) => {
      setAlts(r.hooks)
      if (r.source === "template")
        toast.info("No LLM configured — showing template suggestions")
    },
    onError: (e) => toast.error(e.message),
  })
  return (
    <FieldGroup>
      <SwitchField
        label="Show hook text"
        checked={h.enabled}
        onChange={(v) => set({ enabled: v }, "enabled")}
      />
      <Field>
        <FieldLabel htmlFor="hook-text">Hook</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="hook-text"
            value={h.text}
            onChange={(e) => set({ text: e.target.value }, "text")}
            placeholder="e.g. Nobody talks about this"
          />
          <Button
            variant="secondary"
            onClick={() => gen.mutate()}
            disabled={gen.isPending}
          >
            {gen.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <HugeiconsIcon
                icon={SparklesIcon}
                strokeWidth={2}
                data-icon="inline-start"
              />
            )}
            5 ideas
          </Button>
        </div>
        {ctx.candidate?.suggestedHook &&
        ctx.candidate.suggestedHook !== h.text ? (
          <FieldDescription>
            Suggested:{" "}
            <button
              type="button"
              className="underline"
              onClick={() =>
                set({ text: ctx.candidate?.suggestedHook ?? "" }, "text")
              }
            >
              {ctx.candidate.suggestedHook}
            </button>
          </FieldDescription>
        ) : null}
      </Field>
      {alts.length ? (
        <div className="flex flex-col gap-1">
          {alts.map((a) => (
            <Button
              key={a}
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => set({ text: a }, "text")}
            >
              {a}
            </Button>
          ))}
        </div>
      ) : null}
      <SwitchField
        label="Keep the hook on screen for the whole video"
        description="Stays until the last frame (no fade-out). Turn off to use the duration below."
        checked={h.wholeVideo}
        onChange={(v) => set({ wholeVideo: v }, "wholeVideo")}
      />
      <SliderField
        label="Duration"
        value={h.durationSec}
        min={0.5}
        max={15}
        step={0.5}
        disabled={h.wholeVideo}
        format={(v) => (h.wholeVideo ? "whole video" : `${v}s`)}
        onChange={(v) => set({ durationSec: v }, "duration")}
      />
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Text</FieldLegend>
        <SelectField
          label="Font"
          value={h.font}
          options={FONT_OPTIONS}
          onChange={(v: FontName) => set({ font: v }, "font")}
        />
        <SelectField
          label="Weight"
          value={String(h.fontWeight)}
          options={[
            {
              value: "0",
              label: `Default (${WEIGHT_LABELS[FONT_WEIGHTS[h.font].default]})`,
            },
            ...FONT_WEIGHTS[h.font].weights.map((w) => ({
              value: String(w),
              label: `${WEIGHT_LABELS[w] ?? w} · ${w}`,
            })),
          ]}
          onChange={(v) => set({ fontWeight: Number(v) }, "fontWeight")}
        />
        {h.fontWeight !== 0 &&
        resolveFontWeight(h.font, h.fontWeight) !== h.fontWeight ? (
          <FieldDescription>
            {h.font} has no {h.fontWeight} weight — shown at{" "}
            {resolveFontWeight(h.font, h.fontWeight)}.
          </FieldDescription>
        ) : null}
        <SliderField
          label="Size"
          value={h.fontSize}
          min={32}
          max={140}
          step={1}
          format={(v) => `${v}px`}
          onChange={(v) => set({ fontSize: v }, "size")}
        />
        <div className="grid grid-cols-2 gap-4">
          <SliderField
            label="Letter spacing"
            value={h.letterSpacing}
            min={-0.05}
            max={0.3}
            step={0.005}
            format={(v) => `${v.toFixed(3)}em`}
            onChange={(v) => set({ letterSpacing: v }, "letterSpacing")}
          />
          <SliderField
            label="Line height"
            value={h.lineHeight}
            min={0.8}
            max={1.8}
            step={0.01}
            format={(v) => v.toFixed(2)}
            onChange={(v) => set({ lineHeight: v }, "lineHeight")}
          />
        </div>
        <ToggleField
          label="Alignment"
          value={h.align}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ]}
          onChange={(v) => set({ align: v }, "align")}
        />
        <ColorField
          label="Text color"
          value={h.color}
          onChange={(v) => set({ color: v }, "color")}
        />
        <ColorField
          label="Outline color"
          value={h.strokeColor}
          onChange={(v) => set({ strokeColor: v }, "strokeColor")}
        />
        <SliderField
          label="Outline width"
          value={h.strokeWidth}
          min={0}
          max={24}
          step={1}
          format={(v) => (v ? `${v}px` : "none")}
          onChange={(v) => set({ strokeWidth: v }, "strokeWidth")}
        />
        <SwitchField
          label="UPPERCASE"
          checked={h.uppercase}
          onChange={(v) => set({ uppercase: v }, "uppercase")}
        />
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Box & placement</FieldLegend>
        <SwitchField
          label="Background box"
          checked={h.box}
          onChange={(v) => set({ box: v }, "box")}
        />
        {h.box ? (
          <>
            <ColorField
              label="Box color"
              value={h.background}
              onChange={(v) => set({ background: v }, "bg")}
            />
            <div className="grid grid-cols-2 gap-4">
              <SliderField
                label="Padding"
                value={h.padding}
                min={0}
                max={2.5}
                step={0.05}
                format={(v) => `${v.toFixed(2)}×`}
                onChange={(v) => set({ padding: v }, "padding")}
              />
              <SliderField
                label="Corner radius"
                value={h.radius}
                min={0}
                max={0.8}
                step={0.01}
                format={(v) => `${Math.round(v * h.fontSize)}px`}
                onChange={(v) => set({ radius: v }, "radius")}
              />
            </div>
          </>
        ) : null}
        <SwitchField
          label="Shadow"
          checked={h.shadow}
          onChange={(v) => set({ shadow: v }, "shadow")}
        />
        <SliderField
          label="Vertical position"
          value={h.position}
          min={0.05}
          max={0.9}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ position: v }, "position")}
        />
        <div className="grid grid-cols-2 gap-4">
          <SliderField
            label="Max width"
            value={h.maxWidth}
            min={0.3}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => set({ maxWidth: v }, "maxWidth")}
          />
          <SliderField
            label="Tilt"
            value={h.rotation}
            min={-15}
            max={15}
            step={0.5}
            format={(v) => `${v}°`}
            onChange={(v) => set({ rotation: v }, "rotation")}
          />
        </div>
        <ToggleField
          label="Entrance"
          value={h.animation}
          options={[
            { value: "pop", label: "Pop" },
            { value: "slide", label: "Slide down" },
            { value: "fade", label: "Fade" },
            { value: "none", label: "None" },
          ]}
          onChange={(v) => set({ animation: v }, "animation")}
        />
      </FieldSet>
      <FieldSeparator />
      <HookEmojiFields {...props} />
    </FieldGroup>
  )
}
