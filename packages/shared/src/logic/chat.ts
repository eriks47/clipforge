import type { ChatAnalysis, ChatMessages, TimeRange } from "../schemas/media"
import { rollingMedian } from "./spikes"
import { clamp, mean } from "./util"

/** Twitch VOD id from a URL (twitch.tv/videos/123, m.twitch.tv, …?t=1h2m), else null. */
export function parseTwitchVodId(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/(?:[^/]+\/)?videos?\/(\d+)/i.exec(
    url.trim()
  )
  return m ? m[1] : null
}

// laughter and hype in chat, matched per whitespace token
const LAUGH_RE =
  /^(?:kekw|kek|lul|lulw|omegalul|icant|pepelaugh|lmf?a+o+|lo+l+|ha(?:ha)+h?|xd+|😂|🤣|💀|dead|dying|kappa)$/i
const HYPE_RE =
  /^(?:pog|pogu|pogchamp|poggers|pogg+|w+|clap|monkas|omg|letsgo+|hype|sheesh|clip|clipit|!clip|wtf|fire+|aura+|tuf+|goat|peak|cinema|🔥+|😱|😳|\?+|!+)$/i

/** Does a chat message read as a laugh or a hype / shock reaction? */
export function isReactionMessage(text: string): boolean {
  const t = text.trim()
  if (/\b(no way|lets go+|let's go+|clip (it|that))\b/i.test(t)) return true
  return t.split(/\s+/).some((w) => LAUGH_RE.test(w) || HYPE_RE.test(w))
}

export interface ChatAnalysisOptions {
  hopSec?: number
  /** how far chat lags behind what happens on stream */
  lagSec?: number
  /** smoothing window for the message rate */
  smoothSec?: number
  /** rolling baseline window: activity is relative to this (viewer counts drift over a stream) */
  baselineSec?: number
  /** minimum spacing between reported peaks */
  peakGapSec?: number
  /** window for emote-wave detection */
  convergenceSec?: number
}

const STOPWORDS = new Set(
  "i a an the is are was to of in on it its it's you u he she they we me my and or but so that this what lol? just like be do for not no yes im i'm".split(
    " "
  )
)

/** Normalized tokens of a message: lowercase, long letter runs collapsed (wwww → ww), no @mentions. */
export function chatTokens(text: string): string[] {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/\s+/)) {
    if (!w || w.startsWith("@")) continue
    const t = w
      .replace(
        /^[^\p{L}\p{N}\p{Extended_Pictographic}]+|[^\p{L}\p{N}\p{Extended_Pictographic}]+$/gu,
        ""
      )
      .replace(/(.)\1{2,}/gu, "$1$1")
    if (t && !STOPWORDS.has(t)) out.add(t)
  }
  return [...out]
}

/**
 * Per bin: the share of unique chatters (in a window around it) whose messages contain the single
 * most common token. Computed every other bin and filled, which is plenty at 1 s bins.
 */
function convergence(
  messages: ChatMessages["messages"],
  n: number,
  hop: number,
  windowSec: number
): number[] {
  const out = new Array<number>(n).fill(0)
  const half = windowSec / 2
  const step = 2
  let lo = 0
  for (let i = 0; i < n; i += step) {
    const t = (i + 0.5) * hop
    while (lo < messages.length && messages[lo][0] < t - half) lo++
    const users = new Set<string>()
    const byToken = new Map<string, Set<string>>()
    for (let k = lo; k < messages.length && messages[k][0] < t + half; k++) {
      const [, user, text] = messages[k]
      users.add(user)
      for (const tok of chatTokens(text)) {
        let s = byToken.get(tok)
        if (!s) byToken.set(tok, (s = new Set()))
        s.add(user)
      }
    }
    let best = 0
    for (const s of byToken.values()) best = Math.max(best, s.size)
    // too few chatters, or a window cut off by the start/end of the VOD: not a wave
    const partial = t - half < 0 || t + half > n * hop
    const v = users.size >= 5 && !partial ? best / users.size : 0
    for (let j = i; j < Math.min(n, i + step); j++) out[j] = v
  }
  return out
}

function movingAverage(v: readonly number[], win: number): number[] {
  const half = Math.max(0, Math.floor(win / 2))
  const prefix = [0]
  for (const x of v) prefix.push(prefix[prefix.length - 1] + x)
  return v.map((_, i) => {
    const a = Math.max(0, i - half)
    const b = Math.min(v.length, i + half + 1)
    return (prefix[b] - prefix[a]) / (b - a)
  })
}

const shiftBack = (v: readonly number[], bins: number) =>
  v.map((_, i) => v[Math.min(v.length - 1, i + bins)] ?? 0)

/**
 * Turn a chat replay into per-bin activity: unique chatters per bin, smoothed, relative to the
 * stream's rolling baseline (2× baseline ≈ 0.5, 4× ≈ 1), boosted by laughter/hype share, and
 * shifted back by the chat lag so it lines up with the moment that caused it.
 */
export function buildChatAnalysis(
  chat: ChatMessages,
  duration: number,
  opts: ChatAnalysisOptions = {}
): ChatAnalysis {
  const hop = opts.hopSec ?? 1
  const lag = opts.lagSec ?? 4
  const n = Math.max(1, Math.ceil(duration / hop))
  const count = new Array<number>(n).fill(0)
  const reactions = new Array<number>(n).fill(0)
  const users: Set<string>[] = Array.from({ length: n }, () => new Set())
  for (const [t, user, text] of chat.messages) {
    if (t < 0 || t >= duration) continue
    const i = Math.min(n - 1, Math.floor(t / hop))
    count[i]++
    users[i].add(user)
    if (isReactionMessage(text)) reactions[i]++
  }
  // unique chatters, so one spammer can't fake a moment
  const uniq = users.map((s) => s.size)
  const smooth = movingAverage(uniq, Math.round((opts.smoothSec ?? 5) / hop))
  const baseline = rollingMedian(smooth, Math.round((opts.baselineSec ?? 600) / hop))
  const react = movingAverage(reactions, Math.round((opts.smoothSec ?? 5) / hop))
  const smoothCount = movingAverage(count, Math.round((opts.smoothSec ?? 5) / hop))
  // Emote waves: big chats often sit in slow mode, so their rate stays flat while most chatters
  // suddenly post the same thing ("W", "KEKW"). Measure that convergence against its own baseline.
  const sorted = chat.messages.every((m, i, a) => i === 0 || a[i - 1][0] <= m[0])
    ? chat.messages
    : [...chat.messages].sort((a, b) => a[0] - b[0])
  const conv = convergence(sorted, n, hop, opts.convergenceSec ?? 10)
  const convBase = rollingMedian(conv, Math.round((opts.baselineSec ?? 600) / hop))
  const raw = smooth.map((s, i) => {
    const vol = clamp(Math.log2((s + 0.5) / (baseline[i] + 0.5)) / 2, 0, 1)
    // ~0.6 of chatters on one token = a full wave
    // a wave in a nearly empty chat (stream start, AFK) means little: scale by how busy chat is
    const busy = clamp((s + 0.5) / (0.7 * baseline[i] + 0.5), 0, 1)
    const wave = busy * clamp((conv[i] - convBase[i]) / Math.max(0.6 - convBase[i], 0.15), 0, 1)
    const either = 1 - (1 - vol) * (1 - wave)
    const reactShare = smoothCount[i] > 0 ? clamp(react[i] / smoothCount[i], 0, 1) : 0
    return clamp(either * (0.75 + 0.5 * reactShare), 0, 1)
  })
  const lagBins = Math.round(lag / hop)
  const activity = shiftBack(raw, lagBins)
  const shiftedReactions = shiftBack(reactions, lagBins)

  // local maxima >= 0.45, strongest first, at least peakGapSec apart
  const gap = opts.peakGapSec ?? 20
  const cands: { t: number; strength: number }[] = []
  for (let i = 1; i < n - 1; i++) {
    const a = activity[i]
    if (a >= 0.45 && a >= activity[i - 1] && a >= activity[i + 1])
      cands.push({ t: (i + 0.5) * hop, strength: a })
  }
  cands.sort((x, y) => y.strength - x.strength)
  const peaks: { t: number; strength: number }[] = []
  for (const c of cands) if (peaks.every((p) => Math.abs(p.t - c.t) >= gap)) peaks.push(c)
  peaks.sort((x, y) => x.t - y.t)

  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return {
    source: chat.source,
    videoId: chat.videoId,
    hopSec: hop,
    lagSec: lag,
    totalMessages: chat.messages.length,
    count,
    activity: activity.map(r3),
    reactions: shiftedReactions,
    peaks: peaks.map((p) => ({ t: p.t, strength: r3(p.strength) })),
  }
}

/** Chat activity score for a window (0..1), or null without chat data there. */
export function chatValue(chat: ChatAnalysis, r: TimeRange): number | null {
  const i0 = Math.max(0, Math.floor(r.start / chat.hopSec))
  const i1 = Math.min(chat.activity.length, Math.ceil(r.end / chat.hopSec))
  if (i1 <= i0) return null
  const slice = chat.activity.slice(i0, i1)
  return 0.5 * mean(slice) + 0.5 * Math.max(...slice)
}

/**
 * What chat said during a window (shifted by the lag): message count, rate vs. the whole VOD and
 * the most repeated messages. Shown to the LLM so it knows how chat reacted.
 */
export function chatSummary(
  chat: ChatMessages,
  r: TimeRange,
  lagSec: number,
  vodDuration: number,
  top = 6
): string | null {
  const a = r.start + lagSec
  const b = r.end + lagSec
  const msgs = chat.messages.filter(([t]) => t >= a && t < b)
  if (msgs.length === 0) return null
  const rate = msgs.length / Math.max(b - a, 1)
  const avg = chat.messages.length / Math.max(vodDuration, 1)
  // variants that differ only by repeated letters or case count as one ("WW", "wwww" -> "WWW")
  const freq = new Map<string, { label: string; n: number }>()
  for (const [, , text] of msgs) {
    const label = text
      .trim()
      .replace(/\s+/g, " ")
      .replace(/(.)\1{2,}/gu, "$1$1$1")
      .slice(0, 60)
    const k = label.toLowerCase().replace(/(.)\1+/gu, "$1")
    if (!k) continue
    const e = freq.get(k)
    if (e) e.n++
    else freq.set(k, { label, n: 1 })
  }
  const common = [...freq.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, top)
    .map((e) => `"${e.label}"${e.n > 1 ? ` ×${e.n}` : ""}`)
  return `${msgs.length} msgs (${(rate / Math.max(avg, 1e-6)).toFixed(1)}× the VOD average); top: ${common.join(", ")}`
}

/**
 * Chat peaks strongest first. Activity saturates at 1.0, so busy streams have many tied peaks;
 * ties are broken by how many messages chat posted around the peak (±10 s), not by time
 * (which would always favour the start of the stream).
 */
export function rankChatPeaks(chat: Pick<ChatAnalysis, "peaks" | "count" | "hopSec">) {
  const half = Math.max(1, Math.round(10 / chat.hopSec))
  const volume = (t: number) => {
    const i = Math.floor(t / chat.hopSec)
    let sum = 0
    for (let k = Math.max(0, i - half); k <= Math.min(chat.count.length - 1, i + half); k++)
      sum += chat.count[k]
    return sum
  }
  return chat.peaks
    .map((p) => ({ ...p, volume: volume(p.t) }))
    .sort((a, b) => b.strength - a.strength || b.volume - a.volume)
}
