import { useMemo } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  SmileIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"
import {
  buildCaptionPages,
  isEmoji,
  planEdit,
  retimeWords,
  splitEmojis,
  wordIndicesInRange,
  type Job,
} from "@clipforge/shared"
import { api, type ClipContext } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  EmojiPicker,
  EmojiPickerContent,
  EmojiPickerFooter,
  EmojiPickerSearch,
} from "@/components/ui/emoji-picker"
import { SliderField, SwitchField, ToggleField } from "./fields"
import { patchSection, type PanelProps, type Update } from "./types"

/** How many caption emojis the LLM may pick for this clip at the current frequency. */
function emojiBudget(ctx: ClipContext, cfg: PanelProps["cfg"]): number {
  const duration = planEdit(
    { start: ctx.clip.start, end: ctx.clip.end },
    cfg,
    ctx.transcript
  ).duration
  return Math.max(1, Math.floor(duration / cfg.captions.emojiEverySec) + 1)
}

/** "At most one emoji every N seconds" — applies instantly (render-time spacing) and to the next LLM pick. */
function EmojiFrequency({
  cfg,
  update,
}: {
  cfg: PanelProps["cfg"]
  update: Update
}) {
  const v = cfg.captions.emojiEverySec
  const label = v <= 2 ? "lots" : v <= 4 ? "normal" : v <= 8 ? "few" : "rare"
  return (
    <SliderField
      label="At most one emoji every"
      value={v}
      min={1}
      max={15}
      step={0.5}
      format={(x) => `${x}s · ${label}`}
      description="Lowering the frequency applies immediately; for more emojis, re-pick with the LLM."
      onChange={(x) =>
        patchSection(update, "captions", { emojiEverySec: x }, "emojiEverySec")
      }
    />
  )
}

/** Latest emoji job for the clip + an action to (re-)pick with the LLM. */
function useEmojiPicker(ctx: ClipContext, jobs: Job[]) {
  const system = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    staleTime: 60_000,
  })
  const job = jobs
    .filter((j) => j.type === "emoji" && j.clipId === ctx.clip.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const running = !!job && (job.status === "queued" || job.status === "running")
  const pick = useMutation({
    mutationFn: () => api.pickEmojis(ctx.clip.id),
    onError: (e) => toast.error(e.message),
  })
  const llmOff = system.data?.llm.provider === "none"
  return { job, running, pick: () => pick.mutate(), llmOff }
}

function PickButton({
  picker,
  label,
}: {
  picker: ReturnType<typeof useEmojiPicker>
  label: string
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      className="w-fit"
      onClick={picker.pick}
      disabled={picker.running || picker.llmOff}
    >
      {picker.running ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <HugeiconsIcon
          icon={SparklesIcon}
          strokeWidth={2}
          data-icon="inline-start"
        />
      )}
      {label}
    </Button>
  )
}

const MAX_HOOK_EMOJIS = 8

const QUICK_EMOJIS = [
  "🔥",
  "😂",
  "🤯",
  "😱",
  "💀",
  "👀",
  "🚨",
  "💰",
  "🤑",
  "❤️",
  "😭",
  "🤔",
  "✅",
  "❌",
  "⚠️",
  "🏆",
  "💡",
  "🎯",
  "🚀",
  "👇",
  "⬇️",
  "😳",
  "🙌",
  "💯",
]

/** Hook tab: emoji on/off, side, the chosen emojis (editable, several allowed) and an LLM pick button. */
export function HookEmojiFields({ cfg, update, ctx, jobs }: PanelProps) {
  const h = cfg.hook
  const picker = useEmojiPicker(ctx, jobs)
  const picked = splitEmojis(h.emojiPick)
  const setPick = (emojis: string[]) =>
    patchSection(update, "hook", { emojiPick: emojis.join("") }, "emojiPick")
  return (
    <FieldSet>
      <FieldLegend>Hook emoji</FieldLegend>
      <SwitchField
        label="Add emojis to the hook"
        description="Picked by the LLM before rendering (keyword match without an LLM)."
        checked={h.emoji}
        onChange={(v) => patchSection(update, "hook", { emoji: v }, "emoji")}
      />
      {h.emoji ? (
        <>
          <ToggleField
            label="Position"
            value={h.emojiPosition}
            options={[
              { value: "start", label: "Before text" },
              { value: "end", label: "After text" },
              { value: "both", label: "Both sides" },
            ]}
            onChange={(v) =>
              patchSection(
                update,
                "hook",
                { emojiPosition: v },
                "emojiPosition"
              )
            }
          />
          <Field>
            <FieldLabel htmlFor="hook-emoji">Emojis</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="hook-emoji"
                className="w-40 text-center text-lg"
                placeholder="auto"
                value={h.emojiPick}
                aria-invalid={h.emojiPick !== "" && !isEmoji(h.emojiPick)}
                onChange={(e) =>
                  patchSection(
                    update,
                    "hook",
                    { emojiPick: e.target.value },
                    "emojiPick"
                  )
                }
              />
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={picked.length >= MAX_HOOK_EMOJIS}
                  >
                    <HugeiconsIcon
                      icon={SmileIcon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                    Browse
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-fit p-0">
                  <EmojiPicker
                    className="h-80"
                    columns={9}
                    onEmojiSelect={({ emoji }) =>
                      picked.length < MAX_HOOK_EMOJIS &&
                      setPick([...picked, emoji])
                    }
                  >
                    <EmojiPickerSearch autoFocus placeholder="Search emoji…" />
                    <EmojiPickerContent />
                    <EmojiPickerFooter />
                  </EmojiPicker>
                </PopoverContent>
              </Popover>
              <PickButton
                picker={picker}
                label={h.emojiPick ? "Re-pick with LLM" : "Pick with LLM now"}
              />
            </div>
            {picked.length ? (
              <div className="flex flex-wrap items-center gap-1">
                {picked.map((e, i) => (
                  <Button
                    key={`${e}-${i}`}
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 px-2 text-lg"
                    aria-label={`Remove ${e}`}
                    onClick={() => setPick(picked.filter((_, j) => j !== i))}
                  >
                    {e}
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      strokeWidth={2}
                      className="size-3 text-muted-foreground"
                    />
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-0.5">
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="size-8 rounded text-lg hover:bg-accent disabled:opacity-40"
                  aria-label={`Add ${e}`}
                  disabled={picked.length >= MAX_HOOK_EMOJIS}
                  onClick={() => setPick([...picked, e])}
                >
                  {e}
                </button>
              ))}
            </div>
            <FieldDescription>
              {h.emojiPick
                ? "Add more with Browse or the shortcuts, click a chip to remove it, or type your own."
                : "Empty = picked automatically before rendering."}
              {picker.llmOff
                ? " Select Claude Code or Codex to let the LLM pick."
                : ""}
            </FieldDescription>
          </Field>
          <SliderField
            label="Emojis to pick with the LLM"
            value={h.emojiCount}
            min={1}
            max={5}
            step={1}
            onChange={(v) =>
              patchSection(update, "hook", { emojiCount: v }, "emojiCount")
            }
          />
        </>
      ) : null}
    </FieldSet>
  )
}

/** Captions tab: emoji on/off, the LLM picks per caption line (removable) and a re-pick button. */
export function CaptionEmojiFields({ cfg, update, ctx, jobs }: PanelProps) {
  const c = cfg.captions
  const picker = useEmojiPicker(ctx, jobs)
  const picks = c.emojiPicks
  // caption lines (same grouping the renderer uses) to show what each pick is attached to
  const lines = useMemo(() => {
    const t = ctx.transcript
    if (!t || Object.keys(picks).length === 0) return []
    const range = { start: ctx.clip.start, end: ctx.clip.end }
    const plan = planEdit(range, cfg, t)
    const words = retimeWords(
      t.words,
      wordIndicesInRange(t.words, range),
      plan.edl,
      {
        overrides: c.overrides,
        hidden: c.hiddenWords,
        deleted: cfg.cuts.deletedWords,
      }
    )
    return buildCaptionPages(words, {
      mode: c.mode,
      maxWords: c.maxWords,
      maxChars: c.maxChars,
    }).map((p) => ({
      ids: p.words.map((w) => (w as (typeof words)[number]).idx),
      start: p.start,
      text: p.words.map((w) => w.text).join(" "),
    }))
  }, [ctx.transcript, ctx.clip.start, ctx.clip.end, cfg, c, picks])
  const removePick = (id: string) => {
    const next = { ...picks }
    delete next[id]
    patchSection(update, "captions", { emojiPicks: next }, "emojiPicks")
  }
  const count = Object.keys(picks).length
  return (
    <FieldSet>
      <FieldLegend className="flex items-center gap-2">
        Caption emojis{" "}
        {c.emoji ? (
          <Badge variant="outline">
            {count ? `${count} LLM picks` : "keyword fallback"}
          </Badge>
        ) : null}
      </FieldLegend>
      <SwitchField
        label="Emojis above caption lines"
        description="Before rendering, the LLM picks an emoji for the caption lines that deserve one."
        checked={c.emoji}
        onChange={(v) =>
          patchSection(update, "captions", { emoji: v }, "emoji")
        }
      />
      {c.emoji ? (
        <>
          <EmojiFrequency cfg={cfg} update={update} />
          {count > 0 && count < emojiBudget(ctx, cfg) ? (
            <FieldDescription>
              {count} picks for a budget of {emojiBudget(ctx, cfg)} at this
              frequency — re-pick with the LLM to fill it.
            </FieldDescription>
          ) : null}
          <div className="flex items-center gap-2">
            <PickButton
              picker={picker}
              label={count ? "Re-pick with LLM" : "Pick with LLM now"}
            />
            {count ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  patchSection(
                    update,
                    "captions",
                    { emojiPicks: {} },
                    "emojiPicks"
                  )
                }
              >
                Clear picks
              </Button>
            ) : null}
          </div>
          {picker.llmOff ? (
            <FieldDescription>
              Select Claude Code or Codex to let the LLM pick; until then
              keyword matching is used.
            </FieldDescription>
          ) : null}
          {picker.job?.status === "failed" ? (
            <p className="text-xs text-destructive">{picker.job.error}</p>
          ) : null}
          {lines.length ? (
            <div className="flex flex-col gap-1">
              {Object.entries(picks).map(([id, emoji]) => {
                const line = lines.find((l) => l.ids.includes(Number(id)))
                return (
                  <div
                    key={id}
                    className="flex items-center gap-2 border px-2 py-1 text-xs"
                  >
                    <span className="text-lg leading-none">{emoji}</span>
                    <span className="truncate text-muted-foreground">
                      {line ? line.text : "(line was cut)"}
                    </span>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => removePick(id)}
                      aria-label="Remove emoji"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </FieldSet>
  )
}

/** Pre-render emoji switches next to the Render button. */
export function EmojiRenderToggle({
  cfg,
  update,
}: {
  cfg: PanelProps["cfg"]
  update: Update
}) {
  const on = [
    cfg.hook.emoji && "hook",
    cfg.captions.emoji && "captions",
  ].filter(Boolean)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Emoji settings">
          <HugeiconsIcon
            icon={SmileIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          Emoji{on.length ? `: ${on.join(" + ")}` : ": off"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3">
          <SwitchField
            label="Hook emoji"
            checked={cfg.hook.emoji}
            onChange={(v) =>
              patchSection(update, "hook", { emoji: v }, "emoji")
            }
          />
          <SwitchField
            label="Caption emojis"
            checked={cfg.captions.emoji}
            onChange={(v) =>
              patchSection(update, "captions", { emoji: v }, "emoji")
            }
          />
          {cfg.captions.emoji ? (
            <EmojiFrequency cfg={cfg} update={update} />
          ) : null}
          <p className="text-xs text-muted-foreground">
            Missing picks are chosen by the LLM right before rendering. Review
            or change them in the Hook and Captions tabs.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
