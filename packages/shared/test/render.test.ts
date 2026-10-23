import { describe, expect, it } from "vitest"
import {
  blurBackgroundSigma,
  buildClipRenderProps,
  buildEdl,
  buildFaceTrack,
  buildZoomTrack,
  cropFor,
  defaultEditConfig,
  evalTrack,
  evalZoom,
  FramingConfigSchema,
  resampleToOutput,
  ZoomConfigSchema,
  type FaceSamples,
} from "../src"
import { evenWords, transcriptOf } from "./helpers"

const face = (x: number, size = 0.2, score = 0.9) => ({
  x: x - size / 2,
  y: 0.3,
  w: size,
  h: size,
  score,
})

describe("face tracking", () => {
  const cfg = FramingConfigSchema.parse({ smoothing: 0.5, switchMinSec: 1, holdDropoutSec: 1 })

  it("follows a single face smoothly and holds through dropouts", () => {
    const samples: FaceSamples["samples"] = []
    for (let i = 0; i <= 60; i++) {
      const t = i / 6
      const dropout = t > 4 && t < 4.6
      samples.push({ t, faces: dropout ? [] : [face(t < 5 ? 0.3 : 0.32)] })
    }
    const { primary } = buildFaceTrack({ detector: "test", start: 0, end: 10, samples }, cfg)
    expect(primary[0].cx).toBeCloseTo(0.3)
    // holds position during the dropout instead of drifting to centre
    expect(evalTrack(primary, 4.4).cx).toBeCloseTo(0.3, 1)
    // moves towards the new position without a jump
    const steps = primary.slice(1).map((p, i) => Math.abs(p.cx - primary[i].cx))
    expect(Math.max(...steps)).toBeLessThan(0.02)
    expect(primary.at(-1)!.cx).toBeCloseTo(0.32, 2)
  })

  it("switches to a dominant speaker only after switchMinSec and snaps on scene cuts", () => {
    const samples: FaceSamples["samples"] = []
    for (let i = 0; i <= 60; i++) {
      const t = i / 6
      // speaker A (left) large until 3s, then B (right) larger
      const a = face(0.25, t < 3 ? 0.3 : 0.15)
      const b = face(0.75, t < 3 ? 0.15 : 0.3)
      samples.push({ t, faces: [a, b] })
    }
    const { primary, splitTop, splitBottom } = buildFaceTrack(
      { detector: "test", start: 0, end: 10, samples },
      cfg
    )
    expect(evalTrack(primary, 3.5).cx).toBeLessThan(0.35) // not switched yet
    expect(evalTrack(primary, 6).cx).toBeGreaterThan(0.7) // switched with ease
    expect(splitTop[0].cx).toBeCloseTo(0.25)
    expect(splitBottom[0].cx).toBeCloseTo(0.75)

    const cut = buildFaceTrack({ detector: "test", start: 0, end: 10, samples }, cfg, [3.05])
    expect(evalTrack(cut.primary, 3.2).cx).toBeGreaterThan(0.7) // hard cut on scene change
  })

  it("computes a clamped crop window", () => {
    const c = cropFor(
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { cx: 0, cy: 0.5 },
      1
    )
    expect(c.left).toBe(0)
    expect(c.scale).toBeCloseTo(1920 / 1080)
    const r = cropFor(
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { cx: 1, cy: 0.5 },
      1
    )
    expect(r.left + 1080 / r.scale).toBeCloseTo(1920)
  })

  it("resamples onto the output timeline with hard cuts", () => {
    const edl = buildEdl(
      { start: 0, end: 10 },
      [{ id: "a", kind: "gap", start: 4, end: 6, label: "", active: true }],
      1
    )
    const pts = resampleToOutput(edl, (t) => ({ cx: t / 10, cy: 0.5 }))
    const before = evalTrack(pts, 3.998)
    const after = evalTrack(pts, 4.0)
    expect(before.cx).toBeCloseTo(0.4, 2)
    expect(after.cx).toBeCloseTo(0.6, 2)
  })
})

describe("zooms", () => {
  it("adds punch-ins on spikes respecting max frequency", () => {
    const edl = buildEdl({ start: 0, end: 60 }, [], 1)
    const cfg = ZoomConfigSchema.parse({ auto: { maxPerMinute: 2, intensity: 0.1 } })
    const pts = buildZoomTrack({
      edl,
      spikes: [
        { t: 10, strength: 1 },
        { t: 15, strength: 0.5 },
        { t: 45, strength: 0.8 },
      ],
      emphasis: [],
      cfg,
    })
    const peaks = pts.filter((p) => p.scale > 1)
    expect(peaks.length).toBe(4) // two events x (peak start + hold end)
    expect(evalZoom(pts, 10.5)).toBeCloseTo(1.1)
    expect(evalZoom(pts, 15.5)).toBeCloseTo(1)
    expect(evalZoom(pts, 5)).toBe(1)
  })
})

describe("never framing empty space", () => {
  const cfg = FramingConfigSchema.parse({ smoothing: 0.5, switchMinSec: 1, holdDropoutSec: 0.5 })
  const run = (fn: (t: number) => ReturnType<typeof face>[], scenes: number[] = []) => {
    const samples: FaceSamples["samples"] = []
    for (let i = 0; i <= 60; i++) samples.push({ t: i / 6, faces: fn(i / 6) })
    return buildFaceTrack({ detector: "test", start: 0, end: 10, samples }, cfg, scenes)
  }

  it("starts on the first face of the clip even if the first frames have none", () => {
    const { primary } = run((t) => (t < 2 ? [] : [face(0.27, 0.06)]))
    expect(primary[0].cx).toBeCloseTo(0.27, 2)
    expect(evalTrack(primary, 1).cx).toBeCloseTo(0.27, 2)
  })

  it("holds the last face through long dropouts instead of drifting to the centre", () => {
    const { primary } = run((t) => (t > 3 && t < 9 ? [] : [face(0.73, 0.06)]))
    expect(evalTrack(primary, 8.5).cx).toBeCloseTo(0.73, 2)
  })

  it("snaps to the first face that appears after a scene cut", () => {
    const { primary } = run(
      (t) => (t < 4 ? [face(0.27, 0.06)] : t < 5 ? [] : [face(0.73, 0.06)]),
      [4]
    )
    // first sample with the new face (t = 5): already there, no slow glide across the wall
    expect(evalTrack(primary, 5).cx).toBeCloseTo(0.73, 2)
  })

  it("backfills split tracks with each person's own first position", () => {
    const { splitTop, splitBottom } = run((t) =>
      t < 2 ? [face(0.27, 0.06)] : [face(0.27, 0.06), face(0.73, 0.06)]
    )
    expect(splitBottom[0].cx).toBeCloseTo(0.73, 2)
    expect(splitTop[0].cx).toBeCloseTo(0.27, 2)
  })
})

describe("buildClipRenderProps", () => {
  it("falls back to the full frame (blur fill) when face framing has no faces", () => {
    const base = {
      range: { start: 0, end: 10 },
      config: defaultEditConfig(),
      transcript: null,
      analysis: null,
      scenes: null,
      probe: { width: 1920, height: 1080, fps: 30 },
      video: { src: "x.mp4", fileOffset: 0, width: 1280, height: 720 },
    }
    expect(base.config.framing.mode).toBe("face-track")
    // not detected yet
    expect(buildClipRenderProps({ ...base, faces: null }).framing.mode).toBe("blur-fill")
    // detected, but nobody found
    const empty: FaceSamples = { detector: "t", start: 0, end: 10, samples: [{ t: 1, faces: [] }] }
    expect(buildClipRenderProps({ ...base, faces: empty }).framing.mode).toBe("blur-fill")
    // faces found: crop on them
    const found: FaceSamples = {
      detector: "t",
      start: 0,
      end: 10,
      samples: [{ t: 1, faces: [face(0.27, 0.06)] }],
    }
    const props = buildClipRenderProps({ ...base, faces: found })
    expect(props.framing.mode).toBe("face-track")
    expect(props.framing.track[0].cx).toBeCloseTo(0.27, 2)
  })

  it("builds consistent props for a clip", () => {
    const words = evenWords(100, { gap: 0.6 })
    const config = defaultEditConfig()
    config.hook.text = "Watch this"
    const props = buildClipRenderProps({
      range: { start: 5, end: 25 },
      config,
      transcript: transcriptOf(words),
      analysis: null,
      faces: null,
      scenes: null,
      probe: { width: 1920, height: 1080, fps: 29.97 },
      video: { src: "x.mp4", fileOffset: 0, width: 1280, height: 720 },
    })
    expect(props.fps).toBe(30)
    expect(props.segments.length).toBeGreaterThan(5) // dead air removed between words
    const dur = props.segments.at(-1)!.outEnd
    expect(dur).toBeLessThan(20 / 1.02)
    expect(props.durationInFrames).toBe(Math.round(dur * 30))
    expect(props.captions.pages.length).toBeGreaterThan(0)
    expect(props.captions.pages.at(-1)!.end).toBeLessThanOrEqual(dur + 0.5)
    expect(props.hook).toMatchObject({ enabled: true, start: 0, end: 3 })
  })
})

describe("blur-fill background", () => {
  it("matches the CSS blur radius once the small background is cover-scaled", () => {
    // 480x270 cover-scaled into 1080x1920 is 7.11x, plus the 1.1x overscan
    expect(blurBackgroundSigma(40, { width: 480, height: 270 })).toBeCloseTo(40 / (7.111 * 1.1), 2)
    expect(blurBackgroundSigma(0, { width: 480, height: 270 })).toBe(0)
  })

  it("uses a pre-blurred background only for blur-fill renders", () => {
    const base = {
      range: { start: 0, end: 10 },
      transcript: null,
      analysis: null,
      faces: null,
      scenes: null,
      probe: { width: 1920, height: 1080, fps: 30 },
      video: { src: "v.mp4", fileOffset: 0, width: 1920, height: 1080 },
      background: { src: "bg.mp4", width: 480, height: 270 },
    }
    const cfg = defaultEditConfig()
    cfg.framing.mode = "blur-fill"
    expect(buildClipRenderProps({ ...base, config: cfg }).framing.background?.src).toBe("bg.mp4")
    cfg.framing.mode = "center"
    expect(buildClipRenderProps({ ...base, config: cfg }).framing.background).toBeNull()
    // the editor preview passes none and keeps the CSS blur
    cfg.framing.mode = "blur-fill"
    expect(
      buildClipRenderProps({ ...base, background: undefined, config: cfg }).framing.background
    ).toBeNull()
  })
})
