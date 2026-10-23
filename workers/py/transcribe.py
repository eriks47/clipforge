#!/usr/bin/env python3
"""
Transcribe an audio file with faster-whisper and write word-level timestamps as JSON.

Prints JSON lines on stdout:
  {"type": "log", "message": "..."}
  {"type": "progress", "value": 0.42}
  {"type": "result", "path": "...", "device": "cuda", "model": "..."}

Tries CUDA first (when --device auto|cuda) and falls back to CPU automatically if the GPU
stack fails (e.g. missing cuDNN, or a CTranslate2 build without Blackwell kernels).
"""
import argparse
import json
import os
import sys
import time
import wave


def emit(**kw):
    print(json.dumps(kw), flush=True)


def log(msg):
    emit(type="log", message=str(msg))


def wav_duration(path):
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


def load_wav_16k_mono(path):
    """Read the 16 kHz mono PCM WAV produced by the audio job as float32 (no PyAV dependency)."""
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(model_name, device, compute_type, args, duration, audio):
    from faster_whisper import WhisperModel

    log(f"Loading {model_name} on {device} ({compute_type})")
    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute_type, cpu_threads=max(1, (os.cpu_count() or 4) - 2))
    log(f"Model loaded in {time.time() - t0:.1f}s")
    segments, info = model.transcribe(
        audio,
        language=args.language or None,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
        condition_on_previous_text=False,
    )
    log(f"Language: {info.language} ({info.language_probability:.2f})")
    words = []
    segs = []
    last_emit = 0.0
    for seg in segments:
        seg_words = [w for w in (seg.words or []) if w.word.strip()]
        if not seg_words:
            continue
        first = len(words)
        for w in seg_words:
            words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(max(w.end, w.start + 0.02), 3), "prob": round(w.probability, 3)})
        segs.append({"id": len(segs), "text": seg.text.strip(), "start": round(seg.start, 3), "end": round(seg.end, 3), "wordIdxStart": first, "wordIdxEnd": len(words) - 1})
        if duration > 0 and time.time() - last_emit > 0.5:
            emit(type="progress", value=min(0.999, seg.end / duration))
            last_emit = time.time()
    # whisper occasionally emits slightly out-of-order word times; enforce monotonic starts
    for i in range(1, len(words)):
        if words[i]["start"] < words[i - 1]["start"]:
            words[i]["start"] = words[i - 1]["start"]
        if words[i]["end"] < words[i]["start"]:
            words[i]["end"] = words[i]["start"] + 0.02
    return {"language": info.language, "model": model_name, "device": device, "words": words, "segments": segs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--language", default="en")
    ap.add_argument("--model-gpu", default="large-v3-turbo")
    ap.add_argument("--model-cpu", default="small.en")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    args = ap.parse_args()

    duration = wav_duration(args.audio)
    log(f"Audio duration: {duration:.1f}s")
    audio = load_wav_16k_mono(args.audio)
    result = None
    if args.device in ("auto", "cuda"):
        try:
            import ctranslate2

            n = ctranslate2.get_cuda_device_count()
            if n == 0:
                raise RuntimeError("no CUDA devices visible to CTranslate2")
            result = transcribe(args.model_gpu, "cuda", "float16", args, duration, audio)
        except Exception as e:  # noqa: BLE001 - any GPU failure falls back to CPU
            if args.device == "cuda":
                raise
            log(f"GPU transcription failed ({type(e).__name__}: {e}); falling back to CPU with {args.model_cpu}")
            emit(type="progress", value=0.0)
    if result is None:
        result = transcribe(args.model_cpu, "cpu", "int8", args, duration, audio)

    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, args.out)
    log(f"{len(result['words'])} words, {len(result['segments'])} segments")
    emit(type="result", path=args.out, device=result["device"], model=result["model"])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
