import { forwardRef } from "react"
import { Link } from "react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  Edit02Icon,
  Tick02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"
import { FEATURE_LABELS } from "@clipforge/shared"
import type { CandidateRow } from "@/lib/api"
import { formatDuration, formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** short labels for the LLM's 0-10 aspect scores */
const SUBSCORE_LABELS: Record<string, string> = {
  hook: "hook",
  progress: "progress",
  climax: "climax",
  self_contained: "standalone",
  emotion: "emotion",
  // older rankings
  payoff: "payoff",
  novelty: "novelty",
}

function ratingTone(r: number) {
  if (r >= 75) return "bg-primary text-primary-foreground"
  if (r >= 55) return "bg-secondary text-secondary-foreground"
  return "bg-muted text-muted-foreground"
}

/** Tiny horizontal bar chart of the score breakdown (penalties drawn in destructive). */
function Breakdown({ breakdown }: { breakdown: Record<string, number> }) {
  const entries = Object.entries(breakdown)
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-0.5">
      {entries.map(([k, v]) => (
        <Tooltip key={k}>
          <TooltipTrigger asChild>
            <div className="contents">
              <span className="truncate text-[10px] text-muted-foreground">
                {FEATURE_LABELS[k as keyof typeof FEATURE_LABELS] ?? k}
              </span>
              <div className="h-1.5 w-full bg-muted">
                <div
                  className={cn(
                    "h-full",
                    v < 0 ? "bg-destructive" : "bg-chart-2"
                  )}
                  style={{ width: `${Math.min(100, Math.abs(v))}%` }}
                />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left">
            {FEATURE_LABELS[k as keyof typeof FEATURE_LABELS] ?? k}: {v}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

export interface CandidateCardProps {
  c: CandidateRow
  selected: boolean
  excerpt: string
  onSelect: () => void
  onApprove: () => void
  onReject: () => void
}

export const CandidateCard = forwardRef<HTMLDivElement, CandidateCardProps>(
  function CandidateCard(
    { c, selected, excerpt, onSelect, onApprove, onReject },
    ref
  ) {
    return (
      <div
        ref={ref}
        role="button"
        tabIndex={-1}
        onClick={onSelect}
        className={cn(
          "flex cursor-pointer flex-col gap-2 border bg-card p-3 text-card-foreground transition-colors hover:border-ring",
          selected && "border-primary ring-1 ring-primary",
          c.status === "rejected" && "opacity-55"
        )}
      >
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex size-11 shrink-0 flex-col items-center justify-center font-heading",
              ratingTone(c.finalRating)
            )}
          >
            <span className="text-base leading-none font-semibold">
              {Math.round(c.finalRating)}
            </span>
            <span className="text-[9px] leading-none opacity-80">/100</span>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant="outline" className="capitalize">
                {c.category}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {formatDuration(c.end - c.start)}
              </Badge>
              <span className="font-mono text-[10px] text-muted-foreground">
                {formatTime(c.start)}
              </span>
              {c.status !== "new" ? (
                <Badge
                  variant={c.status === "approved" ? "default" : "destructive"}
                >
                  {c.status}
                </Badge>
              ) : null}
              {c.source === "manual" ? (
                <Badge variant="secondary">manual</Badge>
              ) : null}
              {c.nominated !== null && c.nominated !== undefined ? (
                <Badge
                  variant="secondary"
                  title="Found by the LLM reading the whole transcript"
                >
                  LLM pick
                </Badge>
              ) : null}
            </div>
            <p className="text-xs leading-snug">{c.reason}</p>
            <div className="flex gap-2 text-[10px] text-muted-foreground">
              <span>heuristic {Math.round(c.heuristicScore)}</span>
              {c.llmRating !== null && c.llmRating !== undefined ? (
                <span className="flex items-center gap-0.5">
                  <HugeiconsIcon
                    icon={SparklesIcon}
                    strokeWidth={2}
                    className="size-3"
                  />
                  LLM {Math.round(c.llmRating)}
                </span>
              ) : null}
              {c.llmScores ? (
                <span className="font-mono">
                  {Object.entries(c.llmScores)
                    .map(([k, v]) => `${SUBSCORE_LABELS[k] ?? k} ${v}`)
                    .join(" · ")}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {c.suggestedHook ? (
          <div className="border-l-2 border-primary pl-2 text-xs font-medium">
            “{c.suggestedHook}”
          </div>
        ) : null}
        {selected ? (
          <>
            <p className="line-clamp-4 text-xs text-muted-foreground">
              {excerpt || "(no speech)"}
            </p>
            <Breakdown breakdown={c.breakdown} />
          </>
        ) : (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {excerpt || "(no speech)"}
          </p>
        )}
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            size="xs"
            variant={c.status === "approved" ? "default" : "secondary"}
            onClick={onApprove}
          >
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            Approve
          </Button>
          <Button size="xs" variant="ghost" onClick={onReject}>
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            {c.status === "rejected" ? "Restore" : "Reject"}
          </Button>
          {c.clipId ? (
            <Button size="xs" variant="ghost" className="ml-auto" asChild>
              <Link to={`/clips/${c.clipId}`}>
                <HugeiconsIcon
                  icon={Edit02Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                Edit
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
)
