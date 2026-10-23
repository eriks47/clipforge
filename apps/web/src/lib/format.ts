export function formatTime(sec: number, withMs = false): string {
  if (!Number.isFinite(sec)) return "--:--"
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const ss = withMs
    ? r.toFixed(1).padStart(4, "0")
    : Math.floor(r).toString().padStart(2, "0")
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`
  return formatTime(sec)
}

export function formatRelative(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return "just now"
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

export function formatEta(
  progress: number,
  startedAt: string | null
): string | null {
  if (!startedAt || progress <= 0.01 || progress >= 1) return null
  const elapsed = (Date.now() - new Date(startedAt).getTime()) / 1000
  const remaining = (elapsed / progress) * (1 - progress)
  return remaining < 60
    ? `${Math.round(remaining)}s left`
    : `${Math.round(remaining / 60)} min left`
}

export const JOB_LABELS: Record<string, string> = {
  download: "Download",
  probe: "Probe",
  proxy: "Proxy",
  audio: "Audio extract",
  transcribe: "Transcribe",
  nominate: "LLM moment search",
  audio_features: "Audio features",
  signals: "Audio signals (laughter, voice)",
  visual: "Visual signals (motion, dance)",
  scenes: "Scene cuts",
  heatmap: "Heatmap",
  chat: "Twitch chat",
  candidates: "Candidates",
  rank: "Ranking",
  faces: "Face tracking",
  render: "Render",
  metadata: "Metadata",
  emoji: "Emoji picks",
}
