/**
 * LLM layer tests against fake `claude` / `codex` executables: they record their argv + stdin
 * and answer from a scripted list, so no real model is called.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { config } from "../src/config"
import { buildRankPrompt, createLlmProvider } from "../src/llm"

const dir = mkdtempSync(join(tmpdir(), "clipforge-llm-test-"))
const answersFile = join(dir, "answers.json")
const callsFile = join(dir, "calls.jsonl")

/** Fake CLI: pops the next scripted answer; codex writes it to the -o file, claude prints JSON. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs")
const args = process.argv.slice(2)
const stdin = fs.readFileSync(0, "utf8")
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, stdin }) + "\\n")
const answers = JSON.parse(fs.readFileSync(${JSON.stringify(answersFile)}, "utf8"))
const next = answers.shift()
fs.writeFileSync(${JSON.stringify(answersFile)}, JSON.stringify(answers))
if (args[0] === "exec") fs.writeFileSync(args[args.indexOf("-o") + 1], next)
else process.stdout.write(next)
`

for (const name of ["fake-claude", "fake-codex"]) {
  writeFileSync(join(dir, name), FAKE)
  chmodSync(join(dir, name), 0o755)
}
config.llm.claudeBin = join(dir, "fake-claude")
config.llm.codexBin = join(dir, "fake-codex")

function script(answers: string[]) {
  writeFileSync(answersFile, JSON.stringify(answers))
  writeFileSync(callsFile, "")
}
function calls(): { args: string[]; stdin: string }[] {
  return readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; stdin: string })
}
const claudeOut = (structured: unknown, result = "") =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    structured_output: structured,
  })

const piece = (
  id: number,
  start: number,
  end: number,
  text: string,
  s: boolean,
  e: boolean,
  inside = true
) => ({
  id,
  last: id + text.split(" ").length - 1,
  start,
  end,
  text,
  sentenceStart: s,
  sentenceEnd: e,
  inside,
})
const input = {
  videoTitle: "Test video",
  minSec: 15,
  maxSec: 60,
  candidates: [
    {
      id: "a",
      start: 10,
      end: 40,
      heuristicScore: 61,
      features: { hook: 80 },
      pieces: [
        piece(3, 8.1, 9.6, "And that is why,", true, false, false),
        piece(7, 10.2, 12.0, "Why does nobody talk about this?", true, true),
        piece(13, 12.4, 39.5, "Because it is hard and nobody wants to admit it.", true, true),
      ],
    },
  ],
}
const validRank = {
  candidates: [
    {
      id: "a",
      rating: 83,
      reason: "Strong question hook",
      suggested_hook: "Nobody talks about this",
      suggested_title: "The thing nobody says",
      start_piece: null,
      end_piece: null,
      category: "insight",
    },
  ],
}

beforeEach(() => script([]))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("rank prompt", () => {
  it("includes candidates and live chat when present", () => {
    expect(buildRankPrompt(input)).toContain("id=a")
    expect(buildRankPrompt(input)).not.toContain("live chat:")
    const withChat = {
      ...input,
      candidates: input.candidates.map((c) => ({ ...c, chat: '120 msgs; top: "KEKW" ×80' })),
    }
    expect(buildRankPrompt(withChat)).toContain('live chat: 120 msgs; top: "KEKW" ×80')
  })

  it("lists timestamped sentence/clause pieces so boundaries are chosen by id, not guessed seconds", () => {
    const p = buildRankPrompt(input)
    expect(p).toContain("Clip length when you move boundaries: 15-60 s.")
    expect(p).toContain("~ #3 8.1-9.6s S· And that is why,")
    expect(p).toContain("  #7 10.2-12.0s SE Why does nobody talk about this?")
    expect(p).toContain("S = starts a sentence, E = ends a sentence")
  })
})

describe("claude CLI provider", () => {
  it("calls claude -p with a JSON schema, no tools and the prompt on stdin", async () => {
    script([claudeOut(validRank)])
    const llm = createLlmProvider("claude")!
    const ranked = await llm.rankCandidates(input)
    expect(ranked).toEqual([expect.objectContaining({ id: "a", rating: 83, category: "insight" })])
    const [call] = calls()
    expect(call.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        "--tools",
        "--no-session-persistence",
      ])
    )
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("")
    expect(JSON.parse(call.args[call.args.indexOf("--json-schema") + 1])).toMatchObject({
      type: "object",
      required: ["candidates"],
    })
    expect(call.stdin).toContain("id=a")
  })

  it("validates with zod and retries once with the error", async () => {
    script([claudeOut(null, "here you go: {not json"), claudeOut(validRank)])
    const ranked = await createLlmProvider("claude")!.rankCandidates(input)
    expect(ranked[0].rating).toBe(83)
    const c = calls()
    expect(c).toHaveLength(2)
    expect(c[1].stdin).toContain("previous answer was invalid")
  })

  it("gives up after two invalid answers (caller falls back to heuristics)", async () => {
    const bad = claudeOut({ candidates: [{ id: "a", rating: 500 }] })
    script([bad, bad])
    await expect(createLlmProvider("claude")!.rankCandidates(input)).rejects.toThrow(
      /invalid output twice/
    )
  })

  it("surfaces CLI errors such as not being logged in", async () => {
    script([JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" })])
    await expect(
      createLlmProvider("claude")!.generateHooks({ transcript: "t", current: "h" })
    ).rejects.toThrow(/Not logged in/)
  })
})

describe("codex CLI provider", () => {
  it("runs codex exec read-only with --output-schema and reads the -o file", async () => {
    script([JSON.stringify({ hooks: ["One", "Two", "Three", "Four", "Five", "Six"] })])
    const hooks = await createLlmProvider("codex")!.generateHooks({
      transcript: "about pricing",
      current: "hook",
    })
    expect(hooks).toEqual(["One", "Two", "Three", "Four", "Five"])
    const [call] = calls()
    expect(call.args.slice(0, 3)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral"])
    expect(call.args[call.args.indexOf("--sandbox") + 1]).toBe("read-only")
    expect(call.args).toContain("--output-schema")
    expect(call.args.at(-1)).toBe("-")
    // system prompt and user prompt both go through stdin
    expect(call.stdin).toContain("You write on-screen hooks")
    expect(call.stdin).toContain("about pricing")
  })

  it("generates metadata", async () => {
    script([
      JSON.stringify({
        title: "Pricing truth",
        alt_titles: ["a", "b", "c", "d"],
        description: "desc",
        tags: ["pricing"],
        hashtags: ["shorts", "#pricing"],
      }),
    ])
    const md = await createLlmProvider("codex")!.generateMetadata({
      videoTitle: "v",
      transcript: "t",
      hook: "h",
      category: "insight",
      currentTitle: "c",
    })
    expect(md).toMatchObject({
      title: "Pricing truth",
      altTitles: ["a", "b", "c"],
      hashtags: ["#shorts", "#pricing"],
    })
  })
})

describe("emoji picks", () => {
  const lines = [
    { id: 10, start: 0.2, text: "Charge more than you think" },
    { id: 14, start: 1.5, text: "Seriously, double it" },
    { id: 20, start: 3.1, text: "I hired ten people in two months" },
  ]

  it("asks for hook + lines and keeps only valid picks within budget", async () => {
    script([
      claudeOut({
        hook_emoji: "💸",
        lines: [
          { id: 14, emoji: "✌️" },
          { id: 99, emoji: "🔥" }, // unknown line
          { id: 10, emoji: "money" }, // not an emoji
          { id: 20, emoji: "🤯" },
          { id: 14, emoji: "😂" }, // duplicate line
        ],
      }),
    ])
    const r = await createLlmProvider("claude")!.pickEmojis({
      hook: "Charge more",
      lines,
      maxLines: 1,
      minGapSec: 4,
    })
    expect(r.hook).toBe("💸")
    expect(r.lines).toEqual([{ id: 14, emoji: "✌️" }])
    const [call] = calls()
    expect(call.stdin).toContain('On-screen hook (shown at the start of the video): "Charge more"')
    expect(call.stdin).toContain("14 @1.5s: Seriously, double it")
    expect(call.stdin).toContain("pick at most 1 of these lines")
  })

  it("ignores a hook emoji that was not requested", async () => {
    script([JSON.stringify({ hook_emoji: "🚀", lines: [{ id: 20, emoji: "🤯" }] })])
    const r = await createLlmProvider("codex")!.pickEmojis({
      hook: null,
      lines,
      maxLines: 3,
      minGapSec: 1,
    })
    expect(r).toEqual({ hook: null, lines: [{ id: 20, emoji: "🤯" }] })
    expect(calls()[0].stdin).toContain("No hook emoji is needed")
  })

  it("enforces the minimum spacing between picked lines", async () => {
    // lines start at 0.2 s, 1.5 s and 3.1 s; with 2 s spacing the 1.5 s line must go
    script([
      JSON.stringify({
        hook_emoji: null,
        lines: [
          { id: 10, emoji: "💸" },
          { id: 14, emoji: "✌️" },
          { id: 20, emoji: "🤯" },
        ],
      }),
    ])
    const r = await createLlmProvider("codex")!.pickEmojis({
      hook: null,
      lines,
      maxLines: 5,
      minGapSec: 2,
    })
    expect(r.lines.map((l) => l.id)).toEqual([10, 20])
    expect(calls()[0].stdin).toContain("at least 2 s apart")
  })
})

describe("provider selection", () => {
  it("returns null when no LLM is configured", () => {
    expect(createLlmProvider("none")).toBeNull()
  })
})

describe("moment nomination", () => {
  it("sends the transcript section and returns the model's moments", async () => {
    script([
      claudeOut({ moments: [{ start_piece: 0, climax_piece: 9, end_piece: 12, rating: 77, why: "big reveal" }] }),
    ])
    const moments = await createLlmProvider("claude")!.nominateMoments({
      videoTitle: "Ep 1",
      people: "Sam: host, he/him",
      minSec: 15,
      maxSec: 60,
      count: 3,
      pieces: [
        { id: 0, start: 1, end: 5, text: "So here's the thing." },
        { id: 12, start: 5.5, end: 30, text: "I quit my job yesterday." },
      ],
    })
    expect(moments).toEqual([{ start_piece: 0, climax_piece: 9, end_piece: 12, rating: 77, why: "big reveal" }])
    const stdin = calls()[0].stdin
    expect(stdin).toContain("#12 5.5-30.0s I quit my job yesterday.")
    expect(stdin).toContain("Sam: host, he/him")
    expect(stdin).toContain("Pick up to 3 moments, each 15-60 s long")
  })
})

describe("hook pass", () => {
  it("keeps the model's best hook, falling back to another option that fits the style", async () => {
    script([
      claudeOut({
        clips: [
          { id: "a", options: ["Sam QUIT his job", "Sam was DONE"], best: 0 },
          // best option is a question (rejected), so the next valid one wins
          { id: "b", options: ["Did Sam QUIT?", "Sam REVEALED why he quit"], best: 0 },
          { id: "zzz", options: ["Unknown CLIP"], best: 0 },
        ],
      }),
    ])
    const hooks = await createLlmProvider("claude")!.writeHooks({
      videoTitle: "Ep 1",
      clips: [
        { id: "a", category: "story", reason: "r", transcript: "t" },
        { id: "b", category: "story", reason: "r", transcript: "t" },
      ],
    })
    expect([...hooks]).toEqual([
      ["a", "Sam QUIT his job"],
      ["b", "Sam REVEALED why he quit"],
    ])
  })
})
