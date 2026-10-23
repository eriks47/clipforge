import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import { UserGroupIcon } from "@hugeicons/core-free-icons"
import type { Project } from "@clipforge/shared"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

/** Who appears in the video: passed to every LLM prompt so hooks use real names and pronouns. */
export function PeoplePopover({ project }: { project: Project }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(project.settings.people)
  const save = useMutation({
    mutationFn: (people: string) =>
      api.patchProject(project.id, { settings: { people } }),
    onSuccess: (p) => {
      qc.setQueryData(["project", project.id], p)
      toast.success("People saved", {
        description:
          "Used by new rankings, hooks and metadata. Re-run Candidates to rewrite existing hooks.",
      })
      setOpen(false)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })
  const count = project.settings.people
    .split("\n")
    .filter((l) => l.trim()).length

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setDraft(project.settings.people)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <HugeiconsIcon
            icon={UserGroupIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          People{count ? ` (${count})` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <div className="flex flex-col gap-2">
          <Label htmlFor="people">People in this video</Label>
          <p className="text-xs text-muted-foreground">
            One person per line: name, who they are, pronouns. Hooks and titles
            use these names instead of guessing.
          </p>
          <Textarea
            id="people"
            value={draft}
            maxLength={2000}
            rows={4}
            placeholder={
              "Aishah: the streamer, she/her\nMo: her brother, on camera, he/him"
            }
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={save.isPending || draft === project.settings.people}
              onClick={() => save.mutate(draft)}
            >
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
