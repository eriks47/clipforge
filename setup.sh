#!/usr/bin/env bash
# ClipForge setup: checks system tools, creates the Python venv for ML workers, downloads face models,
# installs Node dependencies. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

echo "== System tools"
if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
  green "ffmpeg: $(ffmpeg -version | head -1)"
  if ffmpeg -hide_banner -v error -f lavfi -i color=c=black:s=256x256:d=0.2 -c:v h264_nvenc -f null - 2>/dev/null; then
    green "NVENC: available"
  else
    yellow "NVENC: not usable, proxies will be encoded with libx264"
  fi
else
  red "ffmpeg/ffprobe not found. Install it (Arch: sudo pacman -S ffmpeg, Mint: sudo apt install ffmpeg)."
  exit 1
fi
if command -v yt-dlp >/dev/null; then green "yt-dlp: $(yt-dlp --version)"; else yellow "yt-dlp: not found (optional, needed for URL imports)"; fi
if command -v nvidia-smi >/dev/null; then
  green "GPU: $(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | head -1)"
else
  yellow "nvidia-smi not found: transcription will run on CPU"
fi

echo "== Node"
if ! command -v node >/dev/null; then red "Node.js >= 22 is required"; exit 1; fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then red "Node.js >= 22 is required (found $(node -v))"; exit 1; fi
green "node $(node -v)"
if ! command -v pnpm >/dev/null; then
  yellow "pnpm not found, installing to ~/.local via npm"
  npm i -g pnpm@10 --prefix "$HOME/.local"
  export PATH="$HOME/.local/bin:$PATH"
fi
pnpm install

echo "== Python venv (workers/py/.venv)"
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.13 python3.11 python3.14 python3; do
    if command -v "$c" >/dev/null; then PY="$c"; break; fi
  done
fi
if [ -z "$PY" ]; then red "Python 3.11+ is required"; exit 1; fi
"$PY" -c 'import sys; assert sys.version_info >= (3, 11), sys.version' || { red "Python 3.11+ is required"; exit 1; }
green "using $($PY --version)"
VENV=workers/py/.venv
[ -d "$VENV" ] || "$PY" -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip >/dev/null
"$VENV/bin/pip" install -r workers/py/requirements.txt

echo "== Face detection models"
mkdir -p workers/py/models
dl() { [ -f "$2" ] || curl -fL --retry 3 -o "$2" "$1" || yellow "could not download $(basename "$2")"; }
dl https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite workers/py/models/blaze_face_short_range.tflite
dl https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx workers/py/models/face_detection_yunet_2023mar.onnx

echo "== CUDA check for transcription"
SITE=$("$VENV/bin/python" -c 'import site; print(site.getsitepackages()[0])')
LIBS=$(ls -d "$SITE"/nvidia/*/lib 2>/dev/null | tr '\n' ':' || true)
if LD_LIBRARY_PATH="$LIBS${LD_LIBRARY_PATH:-}" "$VENV/bin/python" -c 'import ctranslate2,sys; n=ctranslate2.get_cuda_device_count(); print("CTranslate2", ctranslate2.__version__, "CUDA devices:", n); sys.exit(0 if n else 1)'; then
  green "CUDA available to CTranslate2 (the worker still falls back to CPU automatically if GPU inference fails)"
else
  yellow "CUDA not available to CTranslate2: transcription will use CPU (${WHISPER_MODEL_CPU:-small.en})"
fi

[ -f .env ] || cp .env.example .env
mkdir -p data
green "Setup complete. Start with: pnpm dev  (web: http://localhost:5173)"
