#!/usr/bin/env python3
"""
Visual signals for clip finding: a motion curve and a zero-shot "dancing" score.

ffmpeg decodes the video once at 4 fps and 320x180 (NVDEC + scale_cuda when available) and pipes
raw RGB frames here:
  motion  mean absolute frame difference (grayscale, 80x45), with hard cuts removed, per hop
  dance   X-CLIP (microsoft/xclip-base-patch32) on 8 frames at 1 fps (an 8 s clip) every 2 s,
          softmax over dance vs. everyday prompts (talking, gaming, eating, walking...)

Output JSON (all arrays per --hop seconds, default 0.5):
  {"version": 1, "hopSec", "duration", "motion": [...], "cut": [0|1...], "dance": [...], "model"}
JSON-lines progress on stdout like transcribe.py. Without torch/transformers it writes motion only.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np

W, H, FPS = 320, 180, 4
CLIP_FRAMES = 8  # X-CLIP base patch32 is trained on 8 frames
CLIP_STRIDE = FPS  # 1 fps inside a clip -> 8 s of video per clip
CLIP_HOP_SEC = 2.0

DANCE_PROMPTS = [
    "people dancing",
    "a person dancing to music",
    "a dance performance",
    "doing a dance challenge",
    "dancers performing on a stage",
]
OTHER_PROMPTS = [
    "a person talking to the camera",
    "people sitting and talking",
    "playing a video game",
    "a video game screen",
    "people eating food",
    "people walking around",
    "a person cooking",
    "people shopping in a store",
    "a person singing into a microphone",
    "people exercising at the gym",
    "walking down a street at night",
    "a dark, shaky phone video",
    "feet walking on a sidewalk",
    "riding in a car",
    "a crowd of people standing around",
]


def emit(**kw):
    print(json.dumps(kw), flush=True)


def log(msg):
    emit(type="log", message=str(msg))


def ffmpeg_cmd(ffmpeg, video, gpu, codec):
    vf_cpu = f"fps={FPS},scale={W}:{H}:flags=area,format=rgb24"
    if gpu:
        return [ffmpeg, "-hide_banner", "-v", "error", "-hwaccel", "cuda", "-hwaccel_output_format", "cuda",
                "-i", video, "-an", "-sn",
                "-vf", f"scale_cuda={W}:{H}:format=nv12,hwdownload,format=nv12,{vf_cpu}",
                "-f", "rawvideo", "-"]
    # CPU: decode only keyframes where the decoder supports it (h264/hevc), otherwise everything
    pre = ["-skip_frame", "nokey"] if codec in ("h264", "hevc") else []
    return [ffmpeg, "-hide_banner", "-v", "error", "-threads", "0", *pre, "-i", video, "-an", "-sn",
            "-vf", vf_cpu, "-f", "rawvideo", "-"]


class Dance:
    """X-CLIP zero-shot: P(dance prompts) among dance + everyday prompts for an 8-frame clip."""

    def __init__(self, device):
        import torch
        from transformers import AutoTokenizer, XCLIPModel

        name = "microsoft/xclip-base-patch32"
        self.torch = torch
        self.device = device
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        self.model = XCLIPModel.from_pretrained(name, dtype=self.dtype).to(device).eval()
        tok = AutoTokenizer.from_pretrained(name)
        prompts = DANCE_PROMPTS + OTHER_PROMPTS
        self.n_dance = len(DANCE_PROMPTS)
        t = tok(prompts, padding=True, return_tensors="pt").to(device)
        self.text_ids = t["input_ids"]
        self.text_mask = t["attention_mask"]
        self.mean = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=device).view(1, 1, 3, 1, 1)
        self.std = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=device).view(1, 1, 3, 1, 1)
        self.name = name

    def __call__(self, clips):
        """clips: uint8 array (B, 8, H, W, 3) -> np.array (B,) dance probability"""
        torch = self.torch
        with torch.inference_mode():
            x = torch.from_numpy(clips).to(self.device)
            b, f = x.shape[:2]
            x = x.permute(0, 1, 4, 2, 3).float().div_(255)  # B F C H W
            # centre square crop (the subject is usually centred), then resize to 224
            side = min(x.shape[-1], x.shape[-2])
            x0 = (x.shape[-1] - side) // 2
            y0 = (x.shape[-2] - side) // 2
            x = x[..., y0:y0 + side, x0:x0 + side].reshape(b * f, 3, side, side)
            x = torch.nn.functional.interpolate(x, size=(224, 224), mode="bilinear", align_corners=False)
            x = ((x.view(b, f, 3, 224, 224) - self.mean) / self.std).to(self.dtype)
            out = self.model(input_ids=self.text_ids, attention_mask=self.text_mask, pixel_values=x)
            p = out.logits_per_video.float().softmax(-1)
            return p[:, : self.n_dance].sum(-1).cpu().numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--codec", default="")
    ap.add_argument("--gpu-decode", action="store_true")
    ap.add_argument("--hop", type=float, default=0.5)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--no-dance", action="store_true")
    args = ap.parse_args()

    device = "cpu"
    dance = None
    if not args.no_dance:
        try:
            import torch

            device = "cuda" if args.device != "cpu" and torch.cuda.is_available() else "cpu"
            t0 = time.time()
            dance = Dance(device)
            log(f"X-CLIP loaded on {device} in {time.time() - t0:.1f}s")
        except Exception as e:  # noqa: BLE001 - dance detection is optional
            log(f"Dance detection unavailable ({type(e).__name__}: {e}); computing motion only")

    frame_bytes = W * H * 3
    gray_prev = None
    diffs = []  # per decoded frame (4 fps)
    keep = []  # 1 fps frames for X-CLIP, kept in a rolling buffer
    clip_t = []  # clip centre times
    clip_p = []  # dance probability per clip
    batch, batch_t = [], []
    next_clip_end = CLIP_FRAMES  # in 1 fps frames
    clip_hop = int(CLIP_HOP_SEC)

    def flush():
        if batch:
            clip_p.extend(dance(np.stack(batch)).tolist())
            clip_t.extend(batch_t)
            batch.clear()
            batch_t.clear()

    def decode(gpu):
        nonlocal gray_prev, next_clip_end
        # keyframe-only CPU decodes deliver roughly one frame per GOP: use every frame
        stride = CLIP_STRIDE if gpu or args.codec not in ("h264", "hevc") else 1
        proc = subprocess.Popen(ffmpeg_cmd(args.ffmpeg, args.video, gpu, args.codec),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 8)
        n = 0
        last = 0.0
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            fr = np.frombuffer(buf, dtype=np.uint8).reshape(H, W, 3)
            g = fr[::4, ::4].mean(axis=2, dtype=np.float32)  # 80x45 grayscale
            diffs.append(0.0 if gray_prev is None else float(np.abs(g - gray_prev).mean() / 255))
            gray_prev = g
            if dance is not None and n % stride == 0:
                keep.append(fr)
                k = len(keep)
                if k >= next_clip_end:
                    clip = np.stack(keep[k - CLIP_FRAMES:k])
                    batch.append(clip)
                    # clip centre in decoded-frame time (rescaled later for keyframe-only decodes)
                    batch_t.append((n - (CLIP_FRAMES / 2 - 0.5) * stride) / FPS)
                    next_clip_end += clip_hop
                    if len(batch) >= 32:
                        flush()
                    del keep[: max(0, k - CLIP_FRAMES)]
                    next_clip_end -= max(0, k - CLIP_FRAMES)
            n += 1
            if time.time() - last > 1:
                emit(type="progress", value=min(0.99, n / FPS / max(args.duration, 1)))
                last = time.time()
        proc.wait()
        err = proc.stderr.read().decode(errors="replace").strip()
        if proc.returncode != 0:
            raise RuntimeError(err[-500:] or f"ffmpeg exited {proc.returncode}")
        return n

    t0 = time.time()
    frames = 0
    if args.gpu_decode:
        try:
            frames = decode(True)
        except Exception as e:  # noqa: BLE001
            log(f"GPU decode failed ({e}); decoding on the CPU")
            gray_prev = None
            diffs.clear(), keep.clear(), batch.clear(), batch_t.clear(), clip_t.clear(), clip_p.clear()
            next_clip_end = CLIP_FRAMES
    if frames == 0:
        frames = decode(False)
    if dance is not None:
        flush()
    log(f"{frames} frames analysed in {time.time() - t0:.1f}s")

    # frames from a keyframe-only CPU decode are not 4 fps: spread them over the duration
    fps = FPS if frames >= args.duration * FPS * 0.8 else frames / max(args.duration, 1)
    d = np.asarray(diffs, dtype=np.float32)
    # hard cuts: a jump far above the local level -> not motion
    cut = np.zeros_like(d, dtype=bool)
    if len(d) > 2:
        med = np.median(d[d > 0]) if (d > 0).any() else 0
        cut = d > max(0.12, 8 * med)
    d[cut] = 0
    n = int(np.ceil(args.duration / args.hop))
    t_frames = np.arange(len(d)) / fps
    idx = np.minimum((t_frames / args.hop).astype(int), n - 1) if len(d) else np.zeros(0, int)
    motion = np.zeros(n, dtype=np.float32)
    counts = np.zeros(n, dtype=np.float32)
    cuts = np.zeros(n, dtype=np.int8)
    np.add.at(motion, idx, d)
    np.add.at(counts, idx, 1)
    np.maximum.at(cuts, idx, cut.astype(np.int8))
    motion = np.where(counts > 0, motion / np.maximum(counts, 1), 0)

    out = {"version": 1, "hopSec": args.hop, "duration": args.duration,
           "motion": [round(float(v), 4) for v in motion], "cut": cuts.tolist(), "dance": None, "model": None}
    if dance is not None and clip_t:
        t = np.asarray(clip_t) * (FPS / fps)  # decoded-frame time -> seconds
        hops = (np.arange(n) + 0.5) * args.hop
        out["dance"] = [round(float(v), 3) for v in np.interp(hops, t, np.asarray(clip_p))]
        out["model"] = dance.name
        top = np.argsort(clip_p)[-5:][::-1]
        log("top dance clips: " + ", ".join(f"{t[i]:.0f}s={clip_p[i]:.2f}" for i in top))

    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, args.out)
    emit(type="result", path=args.out, frames=frames, device=device)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
