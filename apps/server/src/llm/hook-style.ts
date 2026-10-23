import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Example hooks the LLM imitates; edit the .md file to change the style (read on every call). */
export const HOOK_EXAMPLES_FILE = join(import.meta.dirname, "hook-examples.md")

export const HOOK_MAX_WORDS = 12

export interface HookExample {
  hook: string
  /** what happens in the clip the hook was written for (teaches which angle to pick) */
  moment?: string
  /** kind of hook, e.g. reveal, conflict, fail (lets the model match the clip's type) */
  tag?: string
}

/** `[tag] moment => hook`, where both `[tag]` and `moment =>` are optional. */
export function parseHookExample(line: string): HookExample | null {
  let rest = line.trim()
  if (!rest || rest.startsWith("#")) return null
  let tag: string | undefined
  const t = /^\[([^\]]+)\]\s*/.exec(rest)
  if (t) {
    tag = t[1].trim().toLowerCase()
    rest = rest.slice(t[0].length)
  }
  let moment: string | undefined
  const arrow = rest.indexOf("=>")
  if (arrow >= 0) {
    moment = rest.slice(0, arrow).trim() || undefined
    rest = rest.slice(arrow + 2)
  }
  const hook = rest.trim()
  return hook ? { hook, moment, tag } : null
}

export function loadHookExamples(file = HOOK_EXAMPLES_FILE): HookExample[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map(parseHookExample)
      .filter((e): e is HookExample => e !== null)
  } catch {
    return []
  }
}

function exampleLine(e: HookExample): string {
  return `- ${e.tag ? `[${e.tag}] ` : ""}${e.moment ? `${e.moment} => ` : ""}${e.hook}`
}

/** Style rules + examples shared by every prompt that writes an on-screen hook. */
export function hookStyleGuide(examples = loadHookExamples()): string {
  const withMoment = examples.some((e) => e.moment)
  const tagged = examples.some((e) => e.tag)
  const list = examples.length
    ? `\nExamples of the exact style to copy${withMoment ? " (where given, `moment => hook` shows what happened in that clip and the hook written for it)" : ""}:\n${examples.map(exampleLine).join("\n")}\n` +
      (tagged
        ? "Examples are tagged by type: model your hook on the type that fits the clip. "
        : "") +
      "Copy the tone and the caps style, not the wording: vary the sentence shape between clips."
    : ""
  return `On-screen hook style:
- A one-line, third-person narration of what happens in the clip, like a reaction-channel caption: "<Name> did X", mostly past tense. Not a question, not a quote, not clickbait advice.
- Name the person: use the real name of the speaker / person in the clip when the people list, video title or transcript makes it clear (use the pronouns given in the people list); otherwise a short descriptor ("Her cat", "This streamer", "The guest"). Never invent names.
- Write 2-3 KEY words in ALL CAPS for emphasis (the emotional verb, the surprising object); the rest in normal case.
- At most ${HOOK_MAX_WORDS} words, no emojis, no hashtags, no ending punctuation. Simple, punchy, gossip-like; it must be true to the clip.${list}
In the examples <Name> stands for a real person's name.`
}

/**
 * Normalise an LLM-written hook to the house style, or null when it can't be fixed
 * (too long, hashtags, a question, or no ALL-CAPS emphasis at all).
 */
export function cleanHook(raw: string): string | null {
  const h = raw
    .trim()
    .replace(/^["“”']+|["“”']+$/g, "")
    .replace(/[.!,;:…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!h || h.includes("#") || h.endsWith("?")) return null
  if (/\p{Extended_Pictographic}/u.test(h)) return null
  const words = h.split(" ")
  if (words.length > HOOK_MAX_WORDS) return null
  const caps = words.filter((w) => {
    const letters = w.replace(/[^\p{L}]/gu, "")
    return letters.length >= 2 && letters === letters.toUpperCase()
  }).length
  // a hook in all caps (or none) breaks the style; short hooks may get away with a single caps word
  if (caps === 0 || caps === words.length) return null
  return h
}
