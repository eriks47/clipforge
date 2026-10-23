#!/usr/bin/env python3
"""
Sample frames from a video range and detect faces.

Detectors (first available wins with --detector auto):
  yunet      OpenCV FaceDetectorYN (models/face_detection_yunet_2023mar.onnx). Default: finds faces
             down to ~4% of the frame width, i.e. people in wide podcast/interview shots.
  mediapipe  MediaPipe Tasks FaceDetector (models/blaze_face_short_range.tflite). Selfie-range model:
             misses faces narrower than ~10% of the frame, so it is only the fallback.

Output JSON: {"detector", "start", "end", "samples": [{"t", "faces": [{"x","y","w","h","score"}]}]}
with coordinates normalized to 0..1. JSON-lines progress on stdout like transcribe.py.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")


def emit(**kw):
    print(json.dumps(kw), flush=True)


def log(msg):
    emit(type="log", message=str(msg))


def make_mediapipe():
    path = os.path.join(MODELS, "blaze_face_short_range.tflite")
    if not os.path.exists(path):
        raise RuntimeError("mediapipe model missing")
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import FaceDetector, FaceDetectorOptions

    det = FaceDetector.create_from_options(FaceDetectorOptions(base_options=BaseOptions(model_asset_path=path), min_detection_confidence=0.5))

    def detect(frame_bgr):
        import cv2

        h, w = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        out = []
        for d in res.detections:
            b = d.bounding_box
            score = d.categories[0].score if d.categories else 0.5
            out.append((b.origin_x / w, b.origin_y / h, b.width / w, b.height / h, score))
        return out

    return "mediapipe", detect


def make_yunet():
    path = os.path.join(MODELS, "face_detection_yunet_2023mar.onnx")
    if not os.path.exists(path):
        raise RuntimeError("yunet model missing")
    import cv2

    det = cv2.FaceDetectorYN.create(path, "", (320, 320), 0.6, 0.3, 50)

    def detect(frame_bgr):
        h, w = frame_bgr.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(frame_bgr)
        out = []
        if faces is not None:
            for f in faces:
                # plain floats: numpy float32 is not JSON serializable
                out.append((float(f[0]) / w, float(f[1]) / h, float(f[2]) / w, float(f[3]) / h, float(f[14])))
        return out

    return "yunet", detect


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--every", type=int, default=5, help="sample every N frames")
    ap.add_argument("--out", required=True)
    ap.add_argument("--detector", default="auto", choices=["auto", "yunet", "mediapipe"])
    args = ap.parse_args()

    import cv2

    factories = {"yunet": make_yunet, "mediapipe": make_mediapipe}
    order = ["yunet", "mediapipe"] if args.detector == "auto" else [args.detector]
    name, detect = None, None
    for n in order:
        try:
            name, detect = factories[n]()
            break
        except Exception as e:  # noqa: BLE001
            log(f"{n} unavailable: {e}")
    if detect is None:
        raise RuntimeError("no face detector available (run ./setup.sh to download the YuNet / MediaPipe models)")
    log(f"Using {name} detector")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, args.start) * 1000.0)
    samples = []
    i = 0
    span = max(args.end - args.start, 1e-6)
    while True:
        ok = cap.grab()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        if t > args.end:
            break
        if t < args.start - 0.05:
            continue
        if i % args.every == 0:
            ok, frame = cap.retrieve()
            if ok:
                faces = detect(frame)
                samples.append({"t": round(t, 3), "faces": [{"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4), "score": round(s, 3)} for (x, y, w, h, s) in faces]})
                if len(samples) % 10 == 0:
                    emit(type="progress", value=min(0.999, (t - args.start) / span))
        i += 1
    cap.release()
    result = {"detector": name, "start": args.start, "end": args.end, "fps": fps, "samples": samples}
    tmp = args.out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(result, f)
    os.replace(tmp, args.out)
    found = sum(1 for s in samples if s["faces"])
    log(f"{len(samples)} samples, faces in {found}")
    emit(type="result", path=args.out)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        emit(type="error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
