# Build "ClipForge": a local clipping studio with a web UI

You are building a **local-only** tool that turns a long video (mp4/webm) into ready-to-post vertical Shorts. It runs on my Linux machine (Arch/Mint, NVIDIA RTX 5060 with `nvidia-open` drivers, fish shell). I'm a TypeScript full-stack dev, so keep the app in TypeScript wherever reasonable. Python is only allowed for ML pieces that have no good Node equivalent (transcription, face detection).

Work in the phases at the bottom. **Finish and verify each phase before starting the next.** After each phase, tell me what works, how to run it, and what you stubbed.

---

## 1. Goals

1. Upload a full video (mp4/webm, up to several hours, several GB). Optionally paste a YouTube URL instead.
2. Analyze it automatically: transcription with word timestamps, audio energy, silences, scene cuts, optional YouTube "most replayed" heatmap.
3. Propose **~10 ranked clip candidates**, each with a **0–100 rating**, a score breakdown, and a one-line reason.
4. Let me **preview each candidate instantly** in the browser, adjust in/out points (snapping to word boundaries), approve or reject.
5. For approved clips, open an **editor with live preview**: dead-air removal, filler-word removal, captions, hook text, zooms, 9:16 reframing with face tracking, color, speed, loudness.
6. **Render** clips in a queue (batch-friendly) and generate **title, description, tags** for each.
7. Keep a **posted-clips log** so I can record performance and feed winners back into ranking later.

Non-goals: cloud hosting, user accounts, multi-user support.

---

## 2. Tech stack (use these unless there's a strong reason not to; explain if you deviate)

- **Monorepo** with pnpm workspaces: `apps/server`, `apps/web`, `packages/shared` (types + zod schemas), `packages/remotion` (compositions), `workers/py` (Python ML scripts).
- **Server:** Node 22 + Fastify + TypeScript. Large multipart uploads streamed to disk (no buffering in memory). Server-Sent Events for job progress.
- **DB:** SQLite via `better-sqlite3` + Drizzle ORM. Everything for a project lives in `data/projects/<id>/` (source, audio, transcript, analysis, previews, renders).
- **Job queue:** simple in-process queue persisted in SQLite (jobs table with status/progress/log), concurrency configurable per job type (e.g. transcription 1, preview 2, render 1). Jobs must survive a server restart (mark interrupted ones as failed with a retry button).
- **Web:** Vite + React + TypeScript + Tailwind + TanStack Query. Dark UI. `@remotion/player` for live edit preview.
- **Video:** system `ffmpeg`/`ffprobe` (check they exist at startup and show a clear error if not). Use NVENC (`h264_nvenc`) for proxy/preview encodes when available, fall back to `libx264`.
- **Rendering:** Remotion (`@remotion/renderer`, `@remotion/captions`) called from the server.
- **Transcription:** `faster-whisper` (or WhisperX if it gives better word alignment) in a Python venv, run as a subprocess that prints JSON-lines progress. CUDA if available, CPU fallback with a smaller model. Note: Blackwell GPUs may need a recent CTranslate2/cuDNN; detect failure and fall back to CPU automatically rather than crashing.
- **Face detection:** MediaPipe (Python) subprocess, same JSON-lines pattern.
- **Downloading:** `yt-dlp` (optional dependency, only for the URL import path).
- **LLM:** a pluggable provider interface (`LLMProvider` with `rankCandidates()` and `generateMetadata()`), configured by env vars. Implement an OpenAI-compatible HTTP provider (works with OpenAI, local Ollama, LM Studio etc.) and an Anthropic provider. **Everything must still work with no LLM configured**, using heuristic scores and template metadata.
- Provide a `setup.sh` that creates the Python venv, installs deps, and checks ffmpeg/yt-dlp/CUDA; and a single `pnpm dev` to start everything.

---

## 3. Analysis pipeline (runs automatically after upload)

Each step is its own job with progress, cached to disk, and skipped if its output already exists (so re-running is cheap).

1. **Probe** – ffprobe: duration, fps, resolution, codecs, audio streams.
2. **Proxy** – create a low-res (≤720p, fast-seek, frequent keyframes e.g. `-g 30`) H.264 mp4 for smooth scrubbing in the browser. webm sources must play too.
3. **Audio extract** – 16 kHz mono WAV for transcription; also keep a 48 kHz version for analysis.
4. **Transcribe** – word-level timestamps + segment text + per-word probability. Store as `transcript.json` (see schema in §7). Language auto-detect, with an override in project settings (I work in English, Latvian and Russian).
5. **Audio features** (ffmpeg only, no Python needed):
   - Short-term loudness per 0.5 s via `ebur128` filter (parse momentary/short-term LUFS).
   - Silences via `silencedetect` (configurable noise floor / min duration).
   - Compute a normalized **energy curve** and detect **spikes** (local peaks significantly above a rolling median), which often mean laughter, shouting, reactions.
6. **Scene cuts** – ffmpeg `select='gt(scene,0.3)'` with `showinfo`, store timestamps.
7. **Heatmap (URL imports only)** – `yt-dlp --dump-json` → `heatmap` field if present. Store normalized.
8. **Speech features** derived from the transcript: words per second, pause density, question marks, exclamations, laughter tokens (`[laughter]`, "haha"), profanity, named entities/numbers.
9. **Candidate generation** (see §4).
10. **Ranking** (see §4).

Show all of this on a **timeline visualization** (see UI) so I can see why a moment was picked.

---

## 4. Candidate generation and rating

### 4.1 Generate windows
- Build candidate windows of **15–60 s** (configurable min/max/target), **snapped to sentence/segment boundaries** so clips never start or end mid-word.
- Seed windows around: energy spikes, heatmap peaks, dense-speech segments, and a sliding window across the whole video (so quiet-but-good moments aren't missed).
- Start a few hundred ms before the first word; end after the last word plus a small tail.
- Deduplicate overlapping windows (keep the higher-scoring one, IoU threshold configurable).

### 4.2 Heuristic score (always computed)
Weighted sum of normalized features, weights editable in settings:
- energy peak & variance inside window
- heatmap value (if available)
- speech density (words/sec) and low dead-air ratio
- **hook strength of the first 3 seconds** (energy + whether the first sentence is a question/strong claim)
- clean ending (window ends on sentence end, ideally a punchline/energy bump)
- laughter/exclamation/profanity signals
- penalty for long silences, music-only sections, and transcription low-confidence regions

### 4.3 LLM ranking (if configured)
- Send the top ~30 heuristic candidates (transcript text with timestamps + feature summary), in chunks if needed.
- Ask for strict JSON (validate with zod, retry once on invalid output): per candidate `{ id, rating 0-100, reason (≤20 words), suggested_hook (≤8 words, on-screen text), suggested_title, adjusted_start?, adjusted_end?, category: "funny"|"insight"|"controversial"|"story"|"emotional"|"other" }`.
- Final rating = blend of heuristic and LLM (blend factor in settings). Keep both visible in the UI.
- **Few-shot from my history:** if the posted-clips log has performance data, include 3 top and 3 bottom performers' transcripts + views as examples in the prompt.

Output: top **N (default 10)** candidates, stored in DB with all scores. A "find more" button generates the next batch excluding already-seen windows.

---

## 5. Web UI

### 5.1 Projects page
List of projects (thumbnail, title, duration, status, # candidates, # rendered). Upload via drag-and-drop with a progress bar (resumable or at least robust for multi-GB files) or paste a URL. Delete project (with confirm) cleans its folder.

### 5.2 Analysis/Review page (the main screen)
- **Top:** video player (proxy) + a **multi-track timeline** under it: energy curve, heatmap, silences shaded, scene-cut ticks, candidate regions colored by rating. Click anywhere to seek. Zoomable.
- **Side panel:** ranked candidate cards: rating badge, score breakdown (tiny bar chart), reason, category, suggested hook, duration, transcript excerpt.
- **Click a card** → player jumps to and loops that range. Keyboard: `J/K/L` playback, `Space` play/pause, `I/O` set in/out, `A` approve, `X` reject, `↑/↓` next/prev candidate.
- **Trim:** drag handles on the timeline; in/out snap to word boundaries (hold `Shift` to disable snapping). Show the transcript for the range with words clickable to set in/out.
- Also allow **creating a manual candidate** from any selected range.
- Live job progress for the pipeline via SSE, with per-step status and logs.

### 5.3 Clip editor page (one approved clip)
Left: **live preview** with `@remotion/player` in 9:16, using the same composition that the renderer uses (single source of truth; what I see is what renders). Right: settings panels:

- **Cuts**
  - Dead-air removal: remove gaps between words longer than X ms (default 350), keep Y ms padding. Show the removed segments on a mini-timeline and allow restoring individual cuts by clicking them.
  - Filler-word removal: toggle + editable list (um, uh, like, you know, ну, типа, nu, …). Only cut fillers with enough confidence.
  - Manual word deletion: click words in the transcript to strike them out (cuts that span).
  - Smooth cuts with a very short audio crossfade (~20–40 ms) to avoid pops.
- **Speed:** global speed (default 1.02×) applied without pitch change (atempo).
- **Framing (16:9 → 9:16)**
  - Modes: `face-track` (default), `center`, `manual` (keyframes), `split` (two speakers stacked top/bottom), `blur-fill` (full frame letterboxed over blurred background).
  - Face tracking: sample faces every N frames with MediaPipe, choose the active/largest face, smooth with a critically damped spring or EMA, hold position through short detection dropouts, and switch speakers with a quick ease rather than a hard jump (or a hard cut on scene changes).
- **Zooms**
  - Auto punch-ins: subtle zoom (e.g. 1.0 → 1.12) on energy spikes and on emphasis words; configurable intensity and max frequency (avoid nausea).
  - Manual zoom keyframes on the timeline.
  - Optional quick "punch" zoom on cut points to hide jump cuts.
- **Captions**
  - Word-by-word / phrase-by-phrase (max N words or chars per page) using word timestamps, active-word highlight, pop-in animation.
  - Presets (3–4 styles: bold white with black stroke; yellow highlight; boxed; minimal) + font, size, color, stroke, position, uppercase toggle. Use bundled fonts (e.g. Montserrat ExtraBold, Inter, Bebas Neue via `@remotion/google-fonts`).
  - Inline editable caption text (fix Whisper mistakes) without changing timing; option to hide individual words.
  - Optional emoji on keywords (off by default).
- **Hook:** text at top for the first N seconds (default: whole clip or first 3 s, configurable), styled box, animated in. Prefilled from LLM suggestion; button to regenerate 5 alternatives.
- **Look:** saturation/contrast/brightness sliders (CSS filters in composition), optional vignette, optional slight sharpening.
- **Extras:** progress bar at bottom (toggle), optional watermark/channel handle, optional background music track with auto-ducking under speech, intro "flash" frame.
- **Safe zones overlay** (toggle) showing where YouTube Shorts / TikTok / Reels UI covers the frame, so captions and hook avoid them.
- **Audio:** loudness-normalize final output to −14 LUFS (two-pass `loudnorm`).
- **Presets:** save the whole edit config as a named preset; set a default preset applied to every new clip ("my style").
- Undo/redo for edit config changes.

### 5.4 Render queue page
- Render one or **batch-render all approved clips** with the default preset.
- Progress per render, ETA, cancel, retry. Output to `data/projects/<id>/renders/` and an "Open folder" button; also allow a configurable export directory.
- Output: 1080×1920, 30 or 60 fps (match source when ≤60), H.264 high profile, AAC 192k, mp4, faststart.

### 5.5 Metadata
For each rendered clip, generate (LLM or templates): title (≤ ~70 chars, plus 3 alternatives), description, hashtags/tags; editable fields; "copy all" buttons; export as `<clip>.json` + `<clip>.txt` next to the mp4.

### 5.6 Posted log / analytics (later phase)
Mark a clip as posted (platform, URL, date). Manually enter views/likes at 48 h and 7 d (later: optional YouTube Data API pull). Simple table + chart of performance vs. rating, category, length, hook style — so I can check whether the ratings actually predict views.

---

## 6. Rendering architecture

- One Remotion composition `ShortClip` driven entirely by `ClipRenderProps` (zod schema in `packages/shared`). No per-clip code generation, ever.
- The server computes the **edit decision list (EDL)** from the edit config: list of `{ srcStart, srcEnd }` kept segments after dead-air/filler/manual cuts and speed. Captions, zooms and framing keyframes are re-timed onto the output timeline from that EDL. Put this logic in pure, unit-tested functions in `packages/shared` (it's the most bug-prone part).
- Pre-cut the source to the clip range (plus margin) with ffmpeg before rendering so Remotion doesn't seek through multi-GB files. Use `<OffthreadVideo>`.
- Render with `@remotion/renderer` `renderMedia`, sensible `concurrency`, hardware-accelerated encoding if Remotion supports it on this setup, otherwise x264 with `crf ~18`. Then run the loudnorm pass.

---

## 7. Data contracts (in `packages/shared`, zod + inferred TS types)

Define at least:
- `Transcript { language, words: {text, start, end, prob}[], segments: {id, text, start, end, wordIdxStart, wordIdxEnd}[] }`
- `AudioAnalysis { hopSec, loudness: number[], energyNorm: number[], spikes: {t, strength}[], silences: {start, end}[] }`
- `Candidate { id, projectId, start, end, heuristicScore, llmRating?, finalRating, breakdown: Record<string, number>, reason, category, suggestedHook, suggestedTitle, status: 'new'|'approved'|'rejected' }`
- `EditConfig` (everything in §5.3) and `ClipRenderProps`
- `Job { id, type, projectId, status, progress, log, error, createdAt, updatedAt }`
- `ClipMetadata`, `PostedClip`

---

## 8. Quality bar

- Strict TypeScript, no `any` in shared code. ESLint + Prettier.
- Unit tests (Vitest) for: EDL/cut computation, caption re-timing after cuts and speed change, candidate windowing/snapping/dedup, spike detection, scoring.
- One end-to-end smoke test using a short sample video generated with ffmpeg (test pattern + `sine`/TTS-free audio) that runs the pipeline to a rendered mp4.
- All subprocess calls: timeouts, stderr captured into job log, clear user-facing errors.
- Never block the event loop with heavy work; never load whole videos into memory.
- README: setup, requirements (ffmpeg, Python 3.11+, CUDA notes, yt-dlp optional), env vars, architecture diagram (mermaid), troubleshooting.

---

## 9. Phases

1. **Skeleton** – monorepo, server + web + shared, SQLite, job queue with SSE, upload (streamed) + projects page, ffprobe + proxy generation, player plays the proxy. `setup.sh`, `pnpm dev`.
2. **Analysis** – audio extract, transcription subprocess (GPU w/ CPU fallback), ebur128 energy + spikes, silencedetect, scene cuts; timeline visualization with all tracks.
3. **Candidates** – windowing, heuristic scoring, top-10 cards, loop-preview, trim with word snapping, approve/reject, keyboard shortcuts, manual candidates.
4. **LLM layer** – provider interface (OpenAI-compatible + Anthropic), ranking with zod validation, hooks/titles, graceful no-LLM mode.
5. **Editor + render** – `ShortClip` composition, EDL with dead-air/filler/manual cuts, speed, captions with presets, hook, look filters, safe-zone overlay, live player preview, render queue, loudnorm.
6. **Framing & zooms** – MediaPipe face tracking, smoothing, split/blur-fill modes, auto punch-ins, manual keyframes.
7. **Polish** – presets/default style, metadata generation + export, batch render, URL import with heatmap, undo/redo, posted-clips log with performance chart, few-shot feedback into ranking.

Before writing code for Phase 1, show me the folder structure and the shared schemas briefly, then proceed without waiting unless something is genuinely ambiguous.
