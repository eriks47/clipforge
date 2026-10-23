import type { Category } from "../schemas/candidate"
import type { ClipMetadata } from "../schemas/entities"

const STOPWORDS = new Set(
  "a an the and or but if then so to of in on at for with from by is are was were be been being it its this that these those i you he she we they me my your our their his her them us do does did done have has had not no yes just like really very what when where who why how all any some more most can could would should will about into over out up down than too also only even there here get got go going gonna know think yeah okay ok right well um uh one two nobody somebody someone something everyone everything anyone anything people thing things stuff actually literally basically make made going want said says because about would could should".split(
    " "
  )
)

export function topKeywords(text: string, n = 8): string[] {
  const counts = new Map<string, number>()
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}']+/u)) {
    const w = raw.replace(/^'+|'+$/g, "")
    if (w.length < 4 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([w]) => w)
}

const CATEGORY_TAGS: Record<Category, string[]> = {
  funny: ["funny", "comedy", "lol"],
  insight: ["advice", "learn", "tips"],
  controversial: ["hottake", "debate", "opinion"],
  story: ["story", "storytime"],
  emotional: ["emotional", "real", "motivation"],
  performance: ["dance", "performance", "vibes"],
  other: ["podcast", "clips"],
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max / 2))) + "…"
}

function titleCase(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
}

export interface TemplateMetadataInput {
  transcript: string
  hook: string
  title: string
  category: Category
  sourceTitle?: string
}

/** Metadata without an LLM: built from the transcript, hook and category. */
export function templateMetadata(input: TemplateMetadataInput): ClipMetadata {
  const keywords = topKeywords(input.transcript, 8)
  const base = (
    input.title ||
    input.hook ||
    input.transcript.split(/[.!?]/)[0] ||
    "Watch this"
  ).trim()
  const title = truncate(base.replace(/\s+/g, " "), 70)
  const hook = input.hook.replace(/…$/, "").trim()
  const kw = keywords[0] ? titleCase(keywords[0]) : "This"
  const altTitles = [
    truncate(hook ? `${hook}${/[?!]$/.test(hook) ? "" : "…"}` : `Wait for it…`, 70),
    truncate(`The truth about ${kw.toLowerCase()}`, 70),
    truncate(`${kw}: nobody talks about this`, 70),
  ].filter((t, i, arr) => t && t !== title && arr.indexOf(t) === i)
  const hashtags = [
    "#shorts",
    ...keywords.slice(0, 3).map((k) => `#${k.replace(/[^\p{L}\p{N}]/gu, "")}`),
    ...CATEGORY_TAGS[input.category].slice(0, 1).map((t) => `#${t}`),
  ]
  const sentences = input.transcript.match(/[^.!?]+[.!?]+/g) ?? [input.transcript]
  const summary = truncate(
    sentences
      .slice(0, 2)
      .join(" ")
      .replace(/\b(um|uh|erm)\b[,.]?\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim(),
    220
  )
  // hashtags are kept separate (exported/copied on their own)
  const description = [summary, input.sourceTitle ? `From: ${input.sourceTitle}` : ""]
    .filter(Boolean)
    .join("\n\n")
  const tags = [...new Set([...keywords, ...CATEGORY_TAGS[input.category], "shorts"])].slice(0, 15)
  return { title, altTitles, description, tags, hashtags, source: "template" }
}

/** Five hook alternatives without an LLM. */
export function templateHooks(text: string, current: string): string[] {
  const keywords = topKeywords(text, 4)
  const k = keywords[0] ?? "this"
  const first = (text.split(/[.!?]/)[0] ?? "").split(/\s+/).slice(0, 7).join(" ")
  return [
    current,
    first ? `${first}…` : "",
    `Nobody talks about ${k}`,
    `Wait for the ending`,
    `The truth about ${k}`,
    `This changed how I see ${k}`,
  ]
    .map((h) => h.trim())
    .filter((h, i, arr) => h && arr.indexOf(h) === i)
    .slice(0, 5)
}
