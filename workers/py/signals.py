#!/usr/bin/env python3
"""
Audio signals for clip finding, from the 16 kHz mono WAV:

  AudioSet tags  MIT/ast-finetuned-audioset-10-10-0.4593 (Audio Spectrogram Transformer) on 4 s
                 windows (tiled to the model's 10 s input) every 2 s, grouped into laughter,
                 crowd (cheering/applause), shout (screaming/yelling), gasp, cry, singing, music,
                 danceMusic and speech
  arousal        audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim on 3 s windows every 1.5 s
                 (arousal / dominance / valence, ~0..1): how intense the voice sounds
  pitch          YIN on the GPU (10 ms frames): median and 90th percentile F0 per hop in
                 semitones above 55 Hz (0 = unvoiced), plus the voiced fraction
  effort         spectral balance of voiced frames, dB of 1-5 kHz over 100-1000 Hz energy:
                 shouting tilts the spectrum up, so this separates real vocal effort from volume

Output JSON: {"version": 1, "hopSec", "duration", "models": {...}, "tracks": {name: [...]}} with
every track sampled per --hop seconds. JSON-lines progress on stdout like transcribe.py.
"""
import argparse
import json
import math
import os
import sys
import time
import wave

import numpy as np

SR = 16000
CHUNK_SEC = 600
PAD_SEC = 4.2  # audio read past each chunk so windows starting near its end are complete

AST_NAME = "MIT/ast-finetuned-audioset-10-10-0.4593"
AST_WIN = 400  # fbank frames (10 ms) = 4 s
AST_FRAMES = 1024
AST_GROUPS = {
    "laughter": ["Laughter", "Baby laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle"],
    "crowd": ["Cheering", "Applause", "Crowd", "Clapping"],
    "shout": ["Shout", "Yell", "Screaming", "Bellow", "Whoop", "Battle cry", "Children shouting"],
    "gasp": ["Gasp"],
    "cry": ["Crying, sobbing", "Whimper", "Wail, moan"],
    "singing": ["Singing", "Choir", "Rapping", "Humming", "Male singing", "Female singing", "Child singing", "Chant"],
    "music": ["Music"],
    "danceMusic": ["Dance music", "Electronic dance music", "Hip hop music", "Pop music", "Disco",
                   "House music", "Techno", "Dubstep", "Drum and bass", "Electronic music"],
    "speech": ["Speech"],
}
EMO_NAME = "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
EMO_WIN = 3.0
EMO_HOP = 1.5

YIN_HOP = 160  # 10 ms
YIN_W = 512
F0_MIN, F0_MAX = 70.0, 600.0


def emit(**kw):
    print(json.dumps(kw), flush=True)


def log(msg):
    emit(type="log", message=str(msg))


def read_chunk(w, start, n):
    w.setpos(min(start, w.getnframes()))
    return np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0


class Ast:
    def __init__(self, torch, device, hop_frames):
        import torchaudio.compliance.kaldi as kaldi
        from transformers import ASTForAudioClassification

        self.torch, self.kaldi, self.device = torch, kaldi, device
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        self.model = ASTForAudioClassification.from_pretrained(AST_NAME, dtype=self.dtype).to(device).eval()
        labels = {v: k for k, v in self.model.config.id2label.items()}
        self.groups = {g: [labels[n] for n in names if n in labels] for g, names in AST_GROUPS.items()}
        missing = [n for names in AST_GROUPS.values() for n in names if n not in labels]
        if missing:
            log(f"AST labels not found (ignored): {missing}")
        self.hop = hop_frames

    def __call__(self, x, n_windows):
        """x: chunk audio tensor; returns {group: np.array(n_windows)} for windows every self.hop frames"""
        torch = self.torch
        fb = self.kaldi.fbank(x[None], htk_compat=True, sample_frequency=SR, use_energy=False,
                              window_type="hanning", num_mel_bins=128, dither=0.0, frame_shift=10)
        fb = (fb + 4.2677393) / (4.5689974 * 2)
        rep = math.ceil(AST_FRAMES / AST_WIN)
        out = {g: [] for g in self.groups}
        with torch.inference_mode():
            for b in range(0, n_windows, 32):
                segs = []
                for i in range(b, min(n_windows, b + 32)):
                    s = i * self.hop
                    seg = fb[s:s + AST_WIN]
                    if seg.shape[0] < AST_WIN:  # end of file
                        seg = torch.cat([seg, seg.new_full((AST_WIN - seg.shape[0], 128), -1.27)])
                    segs.append(seg.repeat(rep, 1)[:AST_FRAMES])
                p = torch.sigmoid(self.model(input_values=torch.stack(segs).to(self.dtype)).logits.float())
                for g, idx in self.groups.items():
                    out[g].append(p[:, idx].max(dim=1).values.cpu().numpy())
        return {g: np.concatenate(v) if v else np.zeros(0) for g, v in out.items()}


class Emotion:
    def __init__(self, torch, device):
        import torch.nn as nn
        from transformers import Wav2Vec2Model, Wav2Vec2PreTrainedModel

        class RegressionHead(nn.Module):
            def __init__(self, c):
                super().__init__()
                self.dense = nn.Linear(c.hidden_size, c.hidden_size)
                self.dropout = nn.Dropout(c.final_dropout)
                self.out_proj = nn.Linear(c.hidden_size, c.num_labels)

            def forward(self, x):
                return self.out_proj(self.dropout(torch.tanh(self.dense(self.dropout(x)))))

        class EmotionModel(Wav2Vec2PreTrainedModel):
            def __init__(self, c):
                super().__init__(c)
                self.config = c
                self.wav2vec2 = Wav2Vec2Model(c)
                self.classifier = RegressionHead(c)
                self.post_init()

            def forward(self, x):
                return self.classifier(self.wav2vec2(x)[0].mean(1))

        self.torch, self.device = torch, device
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        self.model = EmotionModel.from_pretrained(EMO_NAME).to(device).to(self.dtype).eval()
        lab = {v: k for k, v in self.model.config.id2label.items()}
        self.ia, self.id, self.iv = lab["arousal"], lab["dominance"], lab["valence"]

    def __call__(self, x, n_windows):
        """returns (arousal, dominance, valence) arrays for 3 s windows every 1.5 s; quiet windows = 0"""
        torch = self.torch
        win, hop = int(EMO_WIN * SR), int(EMO_HOP * SR)
        need = (n_windows - 1) * hop + win
        if x.shape[0] < need:
            x = torch.cat([x, x.new_zeros(need - x.shape[0])])
        frames = x[:need].unfold(0, win, hop)[:n_windows]
        rms = frames.pow(2).mean(1).sqrt()
        loud = (rms > 10 ** (-45 / 20)).nonzero().flatten()
        res = np.zeros((n_windows, 3), dtype=np.float32)
        with torch.inference_mode():
            for b in range(0, len(loud), 16):
                idx = loud[b:b + 16]
                f = frames[idx]
                f = (f - f.mean(1, keepdim=True)) / (f.std(1, keepdim=True) + 1e-7)
                y = self.model(f.to(self.dtype)).float()
                res[idx.cpu().numpy()] = y[:, [self.ia, self.id, self.iv]].cpu().numpy()
        return res[:, 0], res[:, 1], res[:, 2]


def yin_effort(torch, x, n_frames):
    """Per 10 ms frame: f0 in Hz (0 = unvoiced), voiced flag, 1-5 kHz vs 0.1-1 kHz balance in dB."""
    tau_min = int(SR / F0_MAX)
    tau_max = int(SR / F0_MIN)
    n = YIN_W + tau_max
    need = (n_frames - 1) * YIN_HOP + n
    if x.shape[0] < need:
        x = torch.cat([x, x.new_zeros(need - x.shape[0])])
    f0s, voiced, effort = [], [], []
    nfft = 2048
    win = torch.hann_window(YIN_W, device=x.device)
    freqs = torch.fft.rfftfreq(YIN_W, 1 / SR).to(x.device)
    lo = (freqs >= 100) & (freqs < 1000)
    hi = (freqs >= 1000) & (freqs < 5000)
    taus = torch.arange(tau_max + 1, device=x.device, dtype=torch.float32)
    for b in range(0, n_frames, 20000):
        m = min(20000, n_frames - b)
        fr = x[b * YIN_HOP:(b + m - 1) * YIN_HOP + n].unfold(0, n, YIN_HOP)[:m]  # (m, n)
        fr = fr - fr.mean(1, keepdim=True)
        a = fr[:, :YIN_W]
        acf = torch.fft.irfft(torch.fft.rfft(fr, nfft) * torch.fft.rfft(a, nfft).conj(), nfft)[:, :tau_max + 1]
        sq = torch.nn.functional.pad(fr.pow(2).cumsum(1), (1, 0))
        e0 = sq[:, YIN_W:YIN_W + 1]
        et = sq[:, YIN_W:YIN_W + tau_max + 1] - sq[:, : tau_max + 1]
        d = (e0 + et - 2 * acf).clamp_min_(0)
        d[:, 0] = 0
        cm = d[:, 1:].cumsum(1)
        cmndf = torch.ones_like(d)
        cmndf[:, 1:] = d[:, 1:] * taus[1:] / cm.clamp_min(1e-9)
        rng = cmndf[:, tau_min:tau_max]
        below = rng < 0.15
        has = below.any(1)
        first = torch.where(has, below.float().argmax(1), rng.argmin(1))
        # walk from the first dip to its local minimum (look a few lags ahead)
        look = first[:, None] + torch.arange(8, device=x.device)[None]
        look = look.clamp_max(rng.shape[1] - 1)
        vals = rng.gather(1, look)
        k = look.gather(1, vals.argmin(1, keepdim=True)).squeeze(1)
        best = rng.gather(1, k[:, None]).squeeze(1)
        tau = (k + tau_min).float()
        energy_db = 10 * torch.log10(e0.squeeze(1) / YIN_W + 1e-10)
        v = (best < 0.25) & (energy_db > -50)
        f0s.append(torch.where(v, SR / tau, torch.zeros_like(tau)))
        voiced.append(v)
        spec = torch.fft.rfft(a * win).abs().pow(2)
        ratio = 10 * torch.log10((spec[:, hi].sum(1) + 1e-10) / (spec[:, lo].sum(1) + 1e-10))
        effort.append(ratio)
    return torch.cat(f0s), torch.cat(voiced), torch.cat(effort)


def per_hop(values, mask, n_hops, per, fn):
    """Reduce 10 ms frame values to hops of `per` frames using fn over the masked frames (nan if none)."""
    out = np.full(n_hops, np.nan, dtype=np.float32)
    m = min(len(values), n_hops * per)
    v = values[:m]
    k = mask[:m]
    for h in range(min(n_hops, math.ceil(m / per))):
        sel = v[h * per:(h + 1) * per][k[h * per:(h + 1) * per]]
        if sel.size >= 5:
            out[h] = fn(sel)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hop", type=float, default=0.5)
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    args = ap.parse_args()

    import torch

    device = "cuda" if args.device != "cpu" and torch.cuda.is_available() else "cpu"
    if device == "cpu":
        torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2))
    w = wave.open(args.audio, "rb")
    if w.getframerate() != SR or w.getnchannels() != 1 or w.getsampwidth() != 2:
        raise ValueError("expected 16 kHz mono 16-bit WAV")
    total = w.getnframes()
    duration = total / SR
    log(f"Audio duration: {duration:.1f}s, running on {device}")

    t0 = time.time()
    # on the CPU, sample AudioSet tags every 4 s instead of 2 s
    ast_hop = 200 if device == "cuda" else 400
    ast = Ast(torch, device, ast_hop)
    models = {"audioset": AST_NAME}
    try:
        emo = Emotion(torch, device)
        models["emotion"] = EMO_NAME
    except Exception as e:  # noqa: BLE001 - arousal is optional
        log(f"Arousal model unavailable ({type(e).__name__}: {e})")
        emo = None
    log(f"Models loaded in {time.time() - t0:.1f}s")

    ast_step = ast_hop / 100  # seconds between AST windows
    groups = {g: [] for g in AST_GROUPS}
    ar, dom, val = [], [], []
    f0_all, voiced_all, effort_all = [], [], []
    n_ast_total = max(1, math.ceil(duration / ast_step))
    n_emo_total = max(1, math.ceil(duration / EMO_HOP))
    n_yin_total = max(1, math.ceil(total / YIN_HOP))
    ast_done = emo_done = yin_done = 0
    t1 = time.time()
    for c0 in range(0, total, CHUNK_SEC * SR):
        c1 = min(total, c0 + CHUNK_SEC * SR)
        x = torch.from_numpy(read_chunk(w, c0, c1 - c0 + int(PAD_SEC * SR))).to(device)
        last = c1 >= total
        n_ast = n_ast_total - ast_done if last else round((c1 - c0) / SR / ast_step)
        for g, v in ast(x, n_ast).items():
            groups[g].append(v)
        ast_done += n_ast
        if emo is not None:
            n_emo = n_emo_total - emo_done if last else round((c1 - c0) / SR / EMO_HOP)
            a, d, v = emo(x, n_emo)
            ar.append(a), dom.append(d), val.append(v)
            emo_done += n_emo
        n_yin = n_yin_total - yin_done if last else (c1 - c0) // YIN_HOP
        f0, vo, ef = yin_effort(torch, x, n_yin)
        f0_all.append(f0.cpu().numpy()), voiced_all.append(vo.cpu().numpy()), effort_all.append(ef.cpu().numpy())
        yin_done += n_yin
        emit(type="progress", value=min(0.99, c1 / total))
    log(f"Analysed in {time.time() - t1:.1f}s")

    n = int(math.ceil(duration / args.hop))
    centres = (np.arange(n) + 0.5) * args.hop

    def resample(values, step, width):
        t = np.arange(len(values)) * step + width / 2
        return np.interp(centres, t, values) if len(values) else np.zeros(n)

    tracks = {}
    for g, parts in groups.items():
        tracks[g] = resample(np.concatenate(parts), ast_step, AST_WIN / 100)
    if emo is not None:
        tracks["arousal"] = resample(np.concatenate(ar), EMO_HOP, EMO_WIN)
        tracks["dominance"] = resample(np.concatenate(dom), EMO_HOP, EMO_WIN)
        tracks["valence"] = resample(np.concatenate(val), EMO_HOP, EMO_WIN)

    f0 = np.concatenate(f0_all)
    vo = np.concatenate(voiced_all).astype(bool)
    ef = np.concatenate(effort_all)
    per = int(round(args.hop * SR / YIN_HOP))
    semis = np.where(f0 > 0, 12 * np.log2(np.maximum(f0, 1) / 55.0), 0)
    tracks["pitch"] = per_hop(semis, vo, n, per, np.median)
    tracks["pitchHi"] = per_hop(semis, vo, n, per, lambda s: np.percentile(s, 90))
    tracks["voiced"] = np.array([vo[h * per:(h + 1) * per].mean() if h * per < len(vo) else 0 for h in range(n)])
    tracks["effort"] = per_hop(ef, vo, n, per, np.median)

    def clean(a, nd):
        a = np.nan_to_num(np.asarray(a, dtype=np.float64), nan=0.0)
        return [round(float(v), nd) for v in a]

    digits = {"pitch": 2, "pitchHi": 2, "effort": 2}
    out = {"version": 1, "hopSec": args.hop, "duration": duration, "models": models,
           "tracks": {k: clean(v, digits.get(k, 3)) for k, v in tracks.items()}}
    for g in ("laughter", "crowd", "shout", "singing", "music"):
        v = tracks[g]
        top = np.argsort(v)[-3:][::-1]
        log(f"{g}: p95 {np.percentile(v, 95):.3f}, peaks " + ", ".join(f"{centres[i]:.0f}s={v[i]:.2f}" for i in top))
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    os.replace(tmp, args.out)
    emit(type="result", path=args.out, device=device)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
