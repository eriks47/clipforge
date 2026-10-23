import type { EditConfig, EditPlan, Job } from "@clipforge/shared"
import type { ClipContext } from "@/lib/api"

export type Update = (fn: (c: EditConfig) => EditConfig, key: string) => void

export interface PanelProps {
  cfg: EditConfig
  update: Update
  ctx: ClipContext
  plan: EditPlan
  /** current preview time on the output timeline */
  outTime: number
  /** current preview time mapped to source time */
  srcTime: number
  seekSrc: (t: number) => void
  jobs: Job[]
}

/** Shallow-merge one top-level section of the config. */
export function patchSection<K extends keyof EditConfig>(
  update: Update,
  section: K,
  value: Partial<EditConfig[K]>,
  key: string
) {
  update(
    (c) => ({ ...c, [section]: { ...(c[section] as object), ...value } }),
    `${String(section)}.${key}`
  )
}
