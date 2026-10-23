import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import { AiBrain01Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons"
import type { LlmProvider } from "@clipforge/shared"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Link } from "react-router"

export const LLM_LABELS: Record<LlmProvider, string> = {
  none: "Off (heuristics)",
  claude: "Claude Code",
  codex: "Codex",
}

/** Switch the LLM between Claude Code, Codex and off; applies to the next LLM job. */
export function useSetLlm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (provider: LlmProvider) => api.setLlm({ provider }),
    onSuccess: (s, provider) => {
      qc.setQueryData(["settings"], s)
      void qc.invalidateQueries({ queryKey: ["system"] })
      toast.success(`LLM: ${LLM_LABELS[provider]}`)
    },
    onError: (e) => toast.error(e.message),
  })
}

export function LlmSwitcher() {
  const system = useQuery({
    queryKey: ["system"],
    queryFn: api.system,
    staleTime: 60_000,
  })
  const setLlm = useSetLlm()
  const current = (system.data?.llm.provider ?? "none") as LlmProvider
  const clis = system.data?.llm.clis
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="font-mono">
          <HugeiconsIcon
            icon={AiBrain01Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {current === "none" ? "LLM off" : LLM_LABELS[current]}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            data-icon="inline-end"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            LLM for ranking, hooks, metadata & emojis
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(v) => setLlm.mutate(v as LlmProvider)}
          >
            <DropdownMenuRadioItem value="claude" disabled={!clis?.claude}>
              Claude Code
              <span className="ml-auto text-[10px] text-muted-foreground">
                {clis?.claude ? "" : "not installed"}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="codex" disabled={!clis?.codex}>
              Codex
              <span className="ml-auto text-[10px] text-muted-foreground">
                {clis?.codex ? "" : "not installed"}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="none">
              Off (heuristics + templates)
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link to="/settings">Models & connection test…</Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
