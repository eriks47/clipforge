import type { ChatMessages } from "@clipforge/shared"

/**
 * Twitch VOD chat replay via the public GraphQL endpoint the twitch.tv player uses (no login).
 * Cursor paging needs an integrity token, so we page by time offset instead: each request returns
 * ~50 comments starting at an offset; we jump to the last one's offset and dedupe by id. Verified
 * to yield the same messages as probing every second. Seconds with more comments than one page
 * holds are undercounted (rare, and harmless for activity).
 */
const GQL = "https://gql.twitch.tv/gql"
/** the twitch.tv web player's public client id */
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"

export class TwitchError extends Error {}

interface Comment {
  id: string
  contentOffsetSeconds: number
  commenter: { login: string } | null
  message: { fragments: { text: string }[] } | null
}

async function gql<T>(query: string, signal?: AbortSignal): Promise<T> {
  let wait = 1000
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    let res: Response | null = null
    try {
      res = await fetch(GQL, {
        method: "POST",
        headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : undefined,
      })
    } catch (e) {
      if (signal?.aborted) throw e
      // network error / timeout: retry below
    }
    if (res?.ok) {
      const body = (await res.json()) as {
        data?: T
        errors?: { message: string; extensions?: { code?: string } }[]
      }
      if (body.errors?.length) {
        const e = body.errors[0]
        if (e.extensions?.code === "IntegrityCheckFailed")
          throw new TwitchError(
            "Twitch now requires an integrity token for chat replay (their API changed); chat analysis is unavailable for now"
          )
        throw new TwitchError(`Twitch GraphQL error: ${e.message}`)
      }
      if (!body.data) throw new TwitchError("Twitch returned no data")
      return body.data
    }
    // 429 / 5xx / network: back off; other HTTP errors are final
    if (res && res.status < 500 && res.status !== 429)
      throw new TwitchError(`Twitch HTTP ${res.status}`)
    if (attempt >= 6)
      throw new TwitchError(`Twitch unreachable (${res ? `HTTP ${res.status}` : "network error"})`)
    await new Promise((r) => setTimeout(r, wait))
    wait = Math.min(wait * 2, 30000)
  }
}

export async function twitchVodInfo(
  videoId: string,
  signal?: AbortSignal
): Promise<{ title: string; lengthSeconds: number; owner: string | null }> {
  const d = await gql<{
    video: { title: string; lengthSeconds: number; owner: { login: string } | null } | null
  }>(`query { video(id: "${videoId}") { title lengthSeconds owner { login } } }`, signal)
  if (!d.video)
    throw new TwitchError(
      `Twitch VOD ${videoId} not found: it may be deleted, expired, or sub-only`
    )
  return {
    title: d.video.title,
    lengthSeconds: d.video.lengthSeconds,
    owner: d.video.owner?.login ?? null,
  }
}

async function commentsAt(videoId: string, offset: number, signal?: AbortSignal) {
  const d = await gql<{ video: { comments: { edges: { node: Comment }[] } | null } | null }>(
    `query { video(id: "${videoId}") { comments(contentOffsetSeconds: ${Math.max(0, Math.floor(offset))}) { edges { node { id contentOffsetSeconds commenter { login } message { fragments { text } } } } } } }`,
    signal
  )
  if (!d.video) throw new TwitchError(`Twitch VOD ${videoId} disappeared while reading chat`)
  return (d.video.comments?.edges ?? []).map((e) => e.node)
}

export interface ChatDownloadOptions {
  signal?: AbortSignal
  /** parallel requests (4 was fine in testing: ~16 req/s, no throttling) */
  concurrency?: number
  onProgress?: (fraction: number, messages: number) => void
}

/** Download the full chat replay of a VOD. */
export async function downloadTwitchChat(
  videoId: string,
  lengthSeconds: number,
  opts: ChatDownloadOptions = {}
): Promise<ChatMessages> {
  const concurrency = opts.concurrency ?? 4
  // more chunks than workers so a busy stretch doesn't stall one worker
  const chunkSec = Math.max(300, Math.ceil(lengthSeconds / (concurrency * 8)))
  const chunks: { start: number; end: number }[] = []
  for (let s = 0; s < lengthSeconds; s += chunkSec)
    chunks.push({ start: s, end: Math.min(lengthSeconds, s + chunkSec) })
  const byId = new Map<string, [number, string, string]>()
  let covered = 0
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++]
      let off = c.start
      while (off < c.end) {
        const page = await commentsAt(videoId, off, opts.signal)
        for (const m of page) {
          if (m.contentOffsetSeconds < c.start || m.contentOffsetSeconds >= c.end) continue
          const text = (m.message?.fragments ?? []).map((f) => f.text).join("")
          byId.set(m.id, [m.contentOffsetSeconds, m.commenter?.login ?? "", text])
        }
        const last = page.at(-1)?.contentOffsetSeconds ?? c.end
        // jump to the last comment's second; a page that stays in one second moves on by 1
        const nextOff = last > off ? last : off + 1
        covered += Math.min(nextOff, c.end) - off
        off = nextOff
        opts.onProgress?.(Math.min(1, covered / Math.max(lengthSeconds, 1)), byId.size)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
  const messages = [...byId.values()].sort((a, b) => a[0] - b[0])
  return { source: "twitch", videoId, messages }
}
