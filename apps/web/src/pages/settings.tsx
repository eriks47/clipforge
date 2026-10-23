import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import { Delete02Icon, StarIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import {
  AppSettingsSchema,
  FEATURE_LABELS,
  LLM_PROVIDERS,
  type AppSettings,
  type LlmProvider,
  type ScoreWeights,
  type WeightSuggestion,
} from "@clipforge/shared"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { SliderField } from "@/components/editor/fields"
import { LLM_LABELS, useSetLlm } from "@/components/llm-switcher"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/** Fit weights to the user's approve/reject decisions and offer to apply them. */
function LearnWeights({ onApply }: { onApply: (w: ScoreWeights) => void }) {
  const [res, setRes] = useState<WeightSuggestion | null>(null)
  const fit = useMutation({
    mutationFn: api.learnedWeights,
    onSuccess: setRes,
    onError: (e) => toast.error(e.message),
  })
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel>Learn from my decisions</FieldLabel>
        <Button
          size="sm"
          variant="outline"
          disabled={fit.isPending}
          onClick={() => fit.mutate()}
        >
          {fit.isPending && <Spinner />}
          Suggest weights
        </Button>
      </div>
      {res && (
        <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <p className="text-muted-foreground">{res.message}</p>
          {res.changes.length > 0 && (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
              {res.changes.map((ch) => (
                <li key={ch.key} className="flex justify-between gap-2">
                  <span>{FEATURE_LABELS[ch.key]}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {ch.from.toFixed(1)} → {ch.to.toFixed(1)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {res.weights && res.changes.length > 0 && (
            <div>
              <Button
                size="sm"
                onClick={() => {
                  onApply(res.weights!)
                  setRes(null)
                  toast.success("Weights updated — save to keep them")
                }}
              >
                Apply suggestion
              </Button>
            </div>
          )}
        </div>
      )}
    </Field>
  )
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean
  detail: string
}) {
  return (
    <TableRow>
      <TableCell className="w-40 font-medium">{label}</TableCell>
      <TableCell>
        <Badge variant={ok ? "default" : "destructive"}>
          {ok ? "ok" : "missing"}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {detail}
      </TableCell>
    </TableRow>
  )
}

/** Provider switch (applies immediately), per-CLI model, and a round-trip test. */
function LlmFields({
  s,
  setS,
}: {
  s: AppSettings
  setS: (v: AppSettings) => void
}) {
  const system = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    staleTime: 60_000,
  })
  const setLlm = useSetLlm()
  const current = (system.data?.llm.provider ?? "none") as LlmProvider
  const [results, setResults] = useState<
    Partial<Record<"claude" | "codex", string>>
  >({})
  const test = useMutation({
    mutationFn: (provider: "claude" | "codex") =>
      api.testLlm({
        provider,
        model: provider === "claude" ? s.llm.claudeModel : s.llm.codexModel,
      }),
    onSuccess: (r, provider) =>
      setResults((x) => ({
        ...x,
        [provider]: r.ok
          ? `OK in ${(r.ms / 1000).toFixed(1)}s — “${r.sample}”`
          : `Failed: ${r.error}`,
      })),
    onError: (e, provider) =>
      setResults((x) => ({ ...x, [provider]: `Failed: ${e.message}` })),
  })
  const clis = system.data?.llm.clis
  return (
    <>
      <Field>
        <FieldLabel>Provider</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={current}
          onValueChange={(v) => v && setLlm.mutate(v as LlmProvider)}
        >
          {LLM_PROVIDERS.map((p) => (
            <ToggleGroupItem
              key={p}
              value={p}
              disabled={p !== "none" && !clis?.[p]}
            >
              {LLM_LABELS[p]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>
          {system.data?.llm.provider === "none"
            ? "Off: heuristic ranking and template metadata."
            : `Active: ${system.data?.llm.model ?? ""}`}
        </FieldDescription>
      </Field>
      {(["claude", "codex"] as const).map((p) => (
        <Field key={p}>
          <FieldLabel htmlFor={`model-${p}`}>
            {LLM_LABELS[p]} model{" "}
            <span className="font-normal text-muted-foreground">
              {clis?.[p] ?? "not installed"}
            </span>
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id={`model-${p}`}
              placeholder="CLI default"
              value={p === "claude" ? s.llm.claudeModel : s.llm.codexModel}
              onChange={(e) =>
                setS({
                  ...s,
                  llm: {
                    ...s.llm,
                    ...(p === "claude"
                      ? { claudeModel: e.target.value }
                      : { codexModel: e.target.value }),
                  },
                })
              }
            />
            <Button
              variant="outline"
              onClick={() => test.mutate(p)}
              disabled={!clis?.[p] || (test.isPending && test.variables === p)}
            >
              {test.isPending && test.variables === p ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Test
            </Button>
          </div>
          {results[p] ? (
            <FieldDescription>{results[p]}</FieldDescription>
          ) : null}
        </Field>
      ))}
    </>
  )
}

export function SettingsPage() {
  const qc = useQueryClient()
  const remote = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const system = useQuery({ queryKey: ["system"], queryFn: api.system })
  const presets = useQuery({ queryKey: ["presets"], queryFn: api.presets })
  // local edits; null = show the saved settings
  const [draft, setS] = useState<AppSettings | null>(null)
  const s = draft ?? remote.data ?? null
  const save = useMutation({
    // the provider is switched live (header/toggle); never let a stale draft revert it
    mutationFn: (v: AppSettings) =>
      api.saveSettings({
        ...v,
        llm: {
          ...v.llm,
          provider:
            qc.getQueryData<AppSettings>(["settings"])?.llm.provider ??
            v.llm.provider,
        },
      }),
    onSuccess: (v) => {
      qc.setQueryData(["settings"], v)
      void qc.invalidateQueries({ queryKey: ["system"] })
      setS(null)
      toast.success(
        "Settings saved — re-run “Candidates” on a project to apply new scoring"
      )
    },
    onError: (e) => toast.error(e.message),
  })
  const setDefault = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api.patchPreset(id, { makeDefault: on }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] })
      void qc.invalidateQueries({ queryKey: ["presets"] })
      setS(null)
    },
  })
  const delPreset = useMutation({
    mutationFn: api.deletePreset,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["presets"] })
      void qc.invalidateQueries({ queryKey: ["settings"] })
      setS(null)
    },
  })

  if (!s) return <Skeleton className="m-6 h-96" />
  const c = s.candidates
  const setC = (v: Partial<AppSettings["candidates"]>) =>
    setS({ ...s, candidates: { ...c, ...v } })
  const setW = (k: keyof ScoreWeights, v: number) =>
    setC({ weights: { ...c.weights, [k]: v } })
  const a = s.analysis
  const setA = (v: Partial<AppSettings["analysis"]>) =>
    setS({ ...s, analysis: { ...a, ...v } })
  const dirty = JSON.stringify(s) !== JSON.stringify(remote.data)

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            Settings
          </h1>
          <p className="text-sm text-muted-foreground">
            Candidate generation, scoring weights, analysis and export.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() =>
              setS(
                AppSettingsSchema.parse({
                  llm: s.llm,
                  exportDir: s.exportDir,
                  defaultPresetId: s.defaultPresetId,
                })
              )
            }
          >
            Reset to defaults
          </Button>
          <Button
            onClick={() => save.mutate(s)}
            disabled={!dirty || save.isPending}
          >
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            Save settings
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Candidate windows</CardTitle>
            <CardDescription>
              Windows snap to sentence boundaries.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SliderField
                label="Minimum length"
                value={c.minSec}
                min={5}
                max={60}
                step={1}
                format={(v) => `${v}s`}
                onChange={(v) => setC({ minSec: Math.min(v, c.targetSec) })}
              />
              <SliderField
                label="Target length"
                value={c.targetSec}
                min={10}
                max={90}
                step={1}
                format={(v) => `${v}s`}
                onChange={(v) =>
                  setC({ targetSec: Math.max(c.minSec, Math.min(v, c.maxSec)) })
                }
              />
              <SliderField
                label="Maximum length"
                value={c.maxSec}
                min={15}
                max={180}
                step={1}
                format={(v) => `${v}s`}
                onChange={(v) => setC({ maxSec: Math.max(v, c.targetSec) })}
              />
              <SliderField
                label="Candidates per batch"
                value={c.topN}
                min={3}
                max={30}
                step={1}
                onChange={(v) => setC({ topN: v })}
              />
              <SliderField
                label="Overlap threshold (IoU)"
                value={c.iouThreshold}
                min={0.05}
                max={0.9}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => setC({ iouThreshold: v })}
              />
              <SliderField
                label="Lead-in before first word"
                value={c.leadInSec}
                min={0}
                max={1.5}
                step={0.05}
                format={(v) => `${v.toFixed(2)}s`}
                onChange={(v) => setC({ leadInSec: v })}
              />
              <SliderField
                label="Tail after last word"
                value={c.tailSec}
                min={0}
                max={2}
                step={0.05}
                format={(v) => `${v.toFixed(2)}s`}
                onChange={(v) => setC({ tailSec: v })}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Heuristic weights</CardTitle>
            <CardDescription>
              Features are normalized per video. Highlight signals (energy,
              laughter, chat…) are combined so the strongest one counts most;
              structure signals are averaged; penalties subtract.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SliderField
                label="Peak emphasis"
                value={c.peakEmphasis}
                min={1}
                max={6}
                step={0.5}
                format={(v) => (v <= 1 ? "1 (plain average)" : v.toFixed(1))}
                onChange={(v) => setC({ peakEmphasis: v })}
              />
              <FieldDescription>
                1 averages all highlight signals, so one huge laugh is diluted
                by quiet ones. Higher lets the strongest signal dominate.
              </FieldDescription>
              <LearnWeights
                onApply={(w) => setC({ weights: { ...c.weights, ...w } })}
              />
              {(Object.keys(c.weights) as (keyof ScoreWeights)[]).map((k) => (
                <SliderField
                  key={k}
                  label={FEATURE_LABELS[k]}
                  value={c.weights[k]}
                  min={0}
                  max={3}
                  step={0.1}
                  format={(v) => v.toFixed(1)}
                  onChange={(v) => setW(k, v)}
                />
              ))}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>LLM</CardTitle>
            <CardDescription>
              Local CLI agents with your existing login — used for ranking,
              hooks, metadata and emojis. Switching applies to the next job.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <LlmFields s={s} setS={setS} />
              <SliderField
                label="Blend (LLM share of final rating)"
                value={c.llmBlend}
                min={0}
                max={1}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}% LLM`}
                onChange={(v) => setC({ llmBlend: v })}
              />
              <SliderField
                label="Candidates sent to the LLM"
                value={c.llmTopK}
                min={5}
                max={60}
                step={1}
                onChange={(v) => setC({ llmTopK: v })}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Audio & scene analysis</CardTitle>
            <CardDescription>
              Changes apply when a step is re-run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <SliderField
                label="Silence noise floor"
                value={a.silenceNoiseDb}
                min={-60}
                max={-15}
                step={1}
                format={(v) => `${v} dB`}
                onChange={(v) => setA({ silenceNoiseDb: v })}
              />
              <SliderField
                label="Silence min duration"
                value={a.silenceMinSec}
                min={0.2}
                max={3}
                step={0.1}
                format={(v) => `${v.toFixed(1)}s`}
                onChange={(v) => setA({ silenceMinSec: v })}
              />
              <SliderField
                label="Scene cut threshold"
                value={a.sceneThreshold}
                min={0.1}
                max={0.8}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(v) => setA({ sceneThreshold: v })}
              />
              <SliderField
                label="Spike: rolling window"
                value={a.spikeWindowSec}
                min={4}
                max={60}
                step={1}
                format={(v) => `${v}s`}
                onChange={(v) => setA({ spikeWindowSec: v })}
              />
              <SliderField
                label="Spike: min ratio over median"
                value={a.spikeMinRatio}
                min={1.1}
                max={3}
                step={0.05}
                format={(v) => `${v.toFixed(2)}×`}
                onChange={(v) => setA({ spikeMinRatio: v })}
              />
            </FieldGroup>
          </CardContent>
        </Card>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Export</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor="export-dir">Export directory</FieldLabel>
            <Input
              id="export-dir"
              value={s.exportDir}
              placeholder="/home/you/Videos/shorts"
              onChange={(e) => setS({ ...s, exportDir: e.target.value })}
            />
            <FieldDescription>
              Optional. Finished mp4 + .json/.txt metadata are copied here in
              addition to the project's renders folder.
            </FieldDescription>
          </Field>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Style presets</CardTitle>
          <CardDescription>
            Create presets from the editor. The default preset is applied to
            every newly approved clip.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {presets.data?.length ? (
            <Table>
              <TableBody>
                {presets.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.config.captions.preset} captions ·{" "}
                      {p.config.framing.mode} · {p.config.speed.toFixed(2)}×
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant={
                            remote.data?.defaultPresetId === p.id
                              ? "secondary"
                              : "ghost"
                          }
                          onClick={() =>
                            setDefault.mutate({
                              id: p.id,
                              on: remote.data?.defaultPresetId !== p.id,
                            })
                          }
                        >
                          <HugeiconsIcon
                            icon={StarIcon}
                            strokeWidth={2}
                            data-icon="inline-start"
                          />
                          {remote.data?.defaultPresetId === p.id
                            ? "Default"
                            : "Make default"}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          onClick={() => delPreset.mutate(p.id)}
                          aria-label="Delete preset"
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No presets yet.</p>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>System</CardTitle>
          <CardAction>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void system.refetch()}
            >
              Re-check
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {system.data ? (
            <Table>
              <TableBody>
                <StatusRow
                  label="ffmpeg"
                  ok={system.data.ffmpeg.ok}
                  detail={`${system.data.ffmpeg.version ?? "not found"} · NVENC ${system.data.ffmpeg.nvenc ? "yes" : "no"}`}
                />
                <StatusRow
                  label="Python workers"
                  ok={system.data.python.ok}
                  detail={system.data.python.detail ?? system.data.python.path}
                />
                <StatusRow
                  label="yt-dlp (optional)"
                  ok={system.data.ytdlp.ok}
                  detail={
                    system.data.ytdlp.version ??
                    "not installed — URL import unavailable"
                  }
                />
                <StatusRow
                  label="LLM (optional)"
                  ok={system.data.llm.provider !== "none"}
                  detail={
                    system.data.llm.provider === "none"
                      ? "not configured"
                      : `${system.data.llm.provider} · ${system.data.llm.model}`
                  }
                />
                <StatusRow
                  label="Data directory"
                  ok
                  detail={system.data.dataDir}
                />
              </TableBody>
            </Table>
          ) : (
            <Skeleton className="h-32" />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
