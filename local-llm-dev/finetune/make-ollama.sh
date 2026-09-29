#!/usr/bin/env bash
# 병합본(safetensors 폴더)을 Ollama 모델로 등록한다. 운영 모델(qwen3.5-gpu-128k)과 같은
# 파라미터(창 크기·샘플링)를 그대로 물려받아, 측정 차이가 가중치 차이만 반영하게 한다.
#   bash local-llm-dev/finetune/make-ollama.sh <병합본 폴더> <새 태그>   예) runs/r1/merged qwen3.5-ft:r1
#
# 주의: Windows 에서는 safetensors 가져오기가 MLX 를 찾아 실패한다. 그 경우 GGUF 로 먼저 바꾸고
# (README 의 "GGUF 로 배포하기") 이 스크립트 대신 GGUF 를 가리키는 Modelfile 로 등록한다.
set -euo pipefail
merged="$1"; tag="$2"
base_tag="${BASE_TAG:-qwen3.5-gpu-128k:latest}"
# Ollama 0.34 부터 create -q 가 받는 이름이 바뀌었다(q4_K_M → int4/int8/nvfp4/mxfp4/mxfp8).
# 기준 모델은 Q4_K_M 로 만들어 두었으므로 새 모델은 int4 다 — 양자화가 달라 비교에 잡음이 섞이는
# 만큼, 측정 보고에 그 사실을 적는다.
# GGUF 경로에서는 Q5_K_M 을 쓴다 — Q4_K_M 으로 내리면 이 미세조정분이 도구 호출을 잃는다(README).
quant="${QUANT:-int4}"
[ -f "$merged/config.json" ] || { echo "병합본이 아니다: $merged"; exit 2; }
tmp="$(mktemp -d)"
{
  echo "FROM $merged"
  # PARSER 는 **넣지 않는다.** 기준 모델(safetensors 로 가져온 것)에는 `PARSER qwen3.5` 가 붙어
  # 있지만, GGUF 로 가져온 모델에 같은 줄을 넣으면 렌더링이 어긋나 모델이 시스템 글과 요청을
  # 되풀이한다(2026-09-28, 기능 호출 17/30 → 0/30). GGUF 는 제 안의 chat_template 으로 돈다.
  # PARAMETER 는 하나도 빼지 않는다. 벌점까지 그대로 물려받는다.
  ollama show "$base_tag" --modelfile | grep -E '^PARAMETER ' || true
} > "$tmp/Modelfile"
cat "$tmp/Modelfile"
ollama create "$tag" -q "$quant" -f "$tmp/Modelfile"
ollama show "$tag" | head -12
rm -rf "$tmp"
