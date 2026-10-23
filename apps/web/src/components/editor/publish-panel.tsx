import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Copy01Icon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import type { ClipMetadata, Job } from "@clipforge/shared"
import { api, type ClipContext } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

const EMPTY: ClipMetadata = {
  title: "",
  altTitles: [],
  description: "",
  tags: [],
  hashtags: [],
  source: "template",
}

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
}

export function PublishPanel({ ctx, jobs }: { ctx: ClipContext; jobs: Job[] }) {
  const qc = useQueryClient()
  // local edits; null = show what the server has
  const [draft, setDraft] = useState<ClipMetadata | null>(null)
  const md = draft ?? ctx.clip.metadata ?? EMPTY
  const dirty = draft !== null
  const job = jobs
    .filter((j) => j.type === "metadata" && j.clipId === ctx.clip.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const generating =
    job && (job.status === "queued" || job.status === "running")

  const gen = useMutation({
    mutationFn: () => api.generateMetadata(ctx.clip.id),
    onSuccess: () => setDraft(null),
    onError: (e) => toast.error(e.message),
  })
  const save = useMutation({
    mutationFn: () => api.patchClip(ctx.clip.id, { metadata: md }),
    onSuccess: () => {
      setDraft(null)
      toast.success(
        "Metadata saved" +
          (ctx.clip.renderPath ? " (and exported next to the mp4)" : "")
      )
      void qc.invalidateQueries({ queryKey: ["clip-context", ctx.clip.id] })
    },
    onError: (e) => toast.error(e.message),
  })
  const edit = (patch: Partial<ClipMetadata>) => {
    setDraft({ ...md, ...patch })
  }
  const all = [md.title, "", md.description, "", md.hashtags.join(" ")].join(
    "\n"
  )

  return (
    <FieldGroup>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => gen.mutate()}
          disabled={!!generating}
        >
          {generating ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <HugeiconsIcon
              icon={SparklesIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />
          )}
          Generate metadata
        </Button>
        {ctx.clip.metadata ? (
          <Badge variant="outline">
            {ctx.clip.metadata.source === "llm" ? "LLM" : "template"}
          </Badge>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => copy(all, "Everything")}
          disabled={!md.title}
        >
          <HugeiconsIcon
            icon={Copy01Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          Copy all
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor="md-title">Title</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="md-title"
            value={md.title}
            onChange={(e) => edit({ title: e.target.value })}
          />
          <InputGroupAddon align="inline-end">
            <span className="font-mono text-[10px] text-muted-foreground">
              {md.title.length}/70
            </span>
            <InputGroupButton
              size="icon-xs"
              onClick={() => copy(md.title, "Title")}
              aria-label="Copy title"
            >
              <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </Field>
      {md.altTitles.length ? (
        <Field>
          <FieldLabel>Alternatives</FieldLabel>
          <div className="flex flex-col gap-1">
            {md.altTitles.map((t, i) => (
              <Button
                key={i}
                variant="outline"
                size="sm"
                className="justify-start truncate"
                onClick={() =>
                  edit({
                    title: t,
                    altTitles: md.altTitles.map((x, j) =>
                      j === i ? md.title : x
                    ),
                  })
                }
              >
                {t}
              </Button>
            ))}
          </div>
          <FieldDescription>
            Click to swap with the current title.
          </FieldDescription>
        </Field>
      ) : null}
      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="md-desc">Description</FieldLabel>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => copy(md.description, "Description")}
            aria-label="Copy description"
          >
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
          </Button>
        </div>
        <Textarea
          id="md-desc"
          rows={5}
          value={md.description}
          onChange={(e) => edit({ description: e.target.value })}
        />
      </Field>
      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="md-hash">Hashtags</FieldLabel>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => copy(md.hashtags.join(" "), "Hashtags")}
            aria-label="Copy hashtags"
          >
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
          </Button>
        </div>
        <Input
          id="md-hash"
          value={md.hashtags.join(" ")}
          onChange={(e) =>
            edit({ hashtags: e.target.value.split(/\s+/).filter(Boolean) })
          }
        />
      </Field>
      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="md-tags">Tags</FieldLabel>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => copy(md.tags.join(", "), "Tags")}
            aria-label="Copy tags"
          >
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
          </Button>
        </div>
        <Input
          id="md-tags"
          value={md.tags.join(", ")}
          onChange={(e) =>
            edit({
              tags: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </Field>
      <Button
        className="w-fit"
        onClick={() => save.mutate()}
        disabled={!dirty || save.isPending}
      >
        <HugeiconsIcon
          icon={Tick02Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />
        Save metadata
      </Button>
    </FieldGroup>
  )
}
