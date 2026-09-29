#!/usr/bin/env bash
# 기준 모델과 새 모델을 같은 과제·같은 n 으로 잰다. 학습에 없는 과제가 판정이다.
#   bash local-llm-dev/finetune/measure.sh <기준 태그> <새 태그> [REPEATS=20] [TASKS=...]
set -euo pipefail
base="$1"; new="$2"
repeats="${REPEATS:-20}"
tasks="${TASKS:-find-then-edit,pick-comment,python-run,web-to-notion,impossible}"
out="${OUT:-.tuning/ft-measure}"
mkdir -p "$out"
for model in "$base" "$new"; do
  tag="$(echo "$model" | tr ':/' '__')"
  ONLY_TASK="$tasks" REPEATS="$repeats" TRACE_FILE="$out/$tag-trace.jsonl" \
    node local-llm-dev/plan-eval/index-probe.mjs "$model" > "$out/$tag.txt" 2>&1 || true
  echo "== $model"; grep -E "^(X|O) |^요약" "$out/$tag.txt" || tail -5 "$out/$tag.txt"
done
