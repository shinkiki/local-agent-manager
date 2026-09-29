#!/usr/bin/env bash
# 파인튜닝용 파이썬 가상환경을 만든다(한 번). 이미 있으면 그대로 둔다.
#   bash local-llm-dev/finetune/setup-venv.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venv="$here/.venv"
if [ ! -x "$venv/Scripts/python.exe" ] && [ ! -x "$venv/bin/python" ]; then
  python -m venv "$venv"
fi
py="$venv/Scripts/python.exe"; [ -x "$py" ] || py="$venv/bin/python"
"$py" -m pip install --quiet --upgrade pip
# CUDA 12.8 휠. 드라이버가 더 새것이면 그대로 돈다.
"$py" -m pip install --quiet --index-url https://download.pytorch.org/whl/cu128 torch
"$py" -m pip install --quiet transformers peft trl bitsandbytes accelerate datasets huggingface_hub
"$py" - <<'EOF'
import torch, transformers, peft, trl, bitsandbytes
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), "| transformers", transformers.__version__, "| peft", peft.__version__, "| trl", trl.__version__, "| bnb", bitsandbytes.__version__)
EOF
