"""QLoRA 로 계획 프로토콜을 가르친다.

    .venv/Scripts/python local-llm-dev/finetune/train_lora.py \
        --data local-llm-dev/finetune/data/sft.jsonl \
        --base Qwen/Qwen3.5-9B \
        --out local-llm-dev/finetune/runs/<태그>

무엇을 하나: 4비트로 올린 기반 모델에 LoRA(언어 모델 층만)를 얹어 SFT 로 학습하고, 어댑터를
저장한 뒤 병합본(bf16 safetensors)을 `<out>/merged` 에 낸다. Ollama 는 그 폴더를 그대로
가져온다(`make-ollama.sh`).

무엇을 하지 않나: 비전 타워·임베딩·lm_head 는 건드리지 않는다. 학습 데이터에 없는 도구 이름을
외우게 하려는 것이 아니라 add_step → finish_plan 프로토콜을 굳히는 것이므로, 데이터의 시스템 글은
export-sft.mjs 가 지금 계약의 색인으로 다시 만든 것이다.

VRAM 12GB 기준값: 9.4B 4비트 + LoRA r=16, 길이 2048, 배치 1, 누적 8, 그래디언트 체크포인트.
2026-09-28 실측 한 스텝: 1024 토큰 2.4초, 2048 토큰 4.7초, 2304 토큰 114초, 3072 토큰 171초
(VRAM 이 넘쳐 시스템 메모리로 샌다). 절벽은 2048 과 2304 사이다.

표본은 제 길이로 둔다. 전부 가장 긴 것에 맞춰 패딩하면 짧은 표본까지 긴 표본의 값을 치른다 —
계획 표본(2,700)과 AIA 표본(1,250)을 섞을 때 그 차이가 17시간 대 5시간이다.

`--mix` 로 다른 표본 파일을 함께 학습한다. 좁은 과제만 727 건 가르치면 원래 하던 계획 프로토콜을
잊는다(2026-09-29, 계획 탐침 29/30 → 10/30). 계획 표본을 몇십 건 섞는 것은 가르치려는 것이 아니라
잊지 않게 하려는 것이라 `--mix-limit` 으로 줄여 쓴다.
학습 전에 Ollama 가 올려 둔 모델을 내려야 한다(`ollama stop <모델>`) — 안 그러면 CUDA OOM 이다.
"""
import argparse
import json
import os
import pathlib
import sys
import time


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--base", default="Qwen/Qwen3.5-9B")
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--max-length", type=int, default=2048, help="이 기계의 실측 한계. 넘기면 VRAM 이 넘쳐 스텝이 수십 배 느려진다")
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--limit", type=int, default=0, help="표본 상한(연습용)")
    p.add_argument("--mix", default=None, help="함께 학습할 다른 표본 파일. 좁은 과제만 가르치면 원래 하던 것을 잊는다")
    p.add_argument("--mix-limit", type=int, default=0, help="--mix 에서 몇 건만 쓸지. 고르게 뽑는다")
    p.add_argument("--no-merge", action="store_true", help="어댑터만 저장하고 병합본은 내지 않는다")
    p.add_argument("--merge-only", action="store_true", help="학습하지 않고 <out>/adapter 를 병합본으로만 낸다. --no-merge 로 돌린 회차를 나중에 배포할 때 쓴다")
    p.add_argument("--dry-run", action="store_true", help="데이터를 템플릿으로 렌더해 길이만 보고 끝낸다")
    return p.parse_args()


def load_rows(path, limit):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            rows.append({"messages": row["messages"], "tools": row.get("tools")})
            if limit and len(rows) >= limit:
                break
    if not rows:
        sys.exit("학습 표본이 없다")
    return rows


def to_bfloat16(model):
    """fp32 로 올라온 층을 전부 bf16 으로 내린다. **이 기계에서 학습 속도를 가르는 자리다.**

    `prepare_model_for_kbit_training` 은 안정성을 위해 노름과 출력층을 fp32 로 올린다. 그런데 이
    모델의 어휘는 248,320 이라 1024 자리의 로짓만 fp32 로 1.0GB, 기울기까지 2.0GB 다. 12GB 한 장은
    이 지점에서 넘치고, Windows 드라이버는 넘친 만큼을 시스템 메모리로 조용히 돌린다(오류가 아니라
    그냥 느려진다). 2026-09-28 측정: 1024 토큰 한 스텝이 fp32 출력층이면 72초, bf16 이면 2.4초다.
    행렬곱 하나하나가 20배씩 느려져 있었다 — PCIe 대역이 VRAM 대역의 약 1/28 이다.

    LoRA 는 어댑터만 학습하므로 노름을 bf16 으로 둬도 학습이 무너지지 않는다.
    """
    import torch

    lowered = 0
    for _, param in model.named_parameters():
        if param.dtype == torch.float32:
            param.data = param.data.to(torch.bfloat16)
            lowered += 1
    print(f"fp32 층 {lowered}개를 bf16 으로 내렸다", flush=True)
    return model


def merge_adapter(base_name, out, tokenizer):
    """어댑터를 기반 모델에 녹여 bf16 병합본을 낸다.

    4비트 가중치에 얹어 병합하면 손실이 크므로 bf16 기반을 CPU 에 다시 올린다. GPU 는 쓰지 않으니
    학습이 도는 동안에도 돌릴 수 있지만, 18GB 를 쓰고 디스크에 같은 만큼을 쓴다.
    """
    import pathlib as _pathlib

    import torch
    from peft import PeftModel
    from transformers import AutoModelForImageTextToText

    adapter = out / "adapter"
    if not adapter.exists():
        sys.exit(f"어댑터가 없다: {adapter}")
    base = AutoModelForImageTextToText.from_pretrained(base_name, dtype=torch.bfloat16, device_map={"": "cpu"}, low_cpu_mem_usage=True)
    merged = PeftModel.from_pretrained(base, str(adapter)).merge_and_unload()
    merged_dir = out / "merged"
    merged.save_pretrained(str(merged_dir), safe_serialization=True, max_shard_size="5GB")
    tokenizer.save_pretrained(str(merged_dir))
    # Ollama 가져오기와 GGUF 변환에 필요한 부속 파일(전처리 설정·템플릿)을 함께 둔다.
    from huggingface_hub import hf_hub_download

    for name in ("chat_template.jinja", "preprocessor_config.json", "video_preprocessor_config.json", "generation_config.json"):
        try:
            src = hf_hub_download(base_name, name)
            (merged_dir / name).write_bytes(_pathlib.Path(src).read_bytes())
        except Exception as error:  # 없는 파일은 건너뛴다
            print(f"부속 파일 건너뜀 {name}: {error}", flush=True)
    print(f"병합본: {merged_dir}", flush=True)


def main():
    args = parse_args()
    if args.merge_only:
        from transformers import AutoTokenizer

        out = pathlib.Path(args.out)
        tokenizer = AutoTokenizer.from_pretrained(args.base)
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        merge_adapter(args.base, out, tokenizer)
        return
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = load_rows(args.data, args.limit)
    if args.mix:
        extra = load_rows(args.mix, 0)
        if args.mix_limit and args.mix_limit < len(extra):
            # 앞에서 자르지 않고 고르게 뽑는다 — 앞쪽에 한 과제가 몰려 있을 수 있다.
            step = len(extra) / args.mix_limit
            extra = [extra[int(i * step)] for i in range(args.mix_limit)]
        print(f"섞을 표본 {len(extra)}건 ({args.mix})", flush=True)
        rows = rows + extra
    print(f"표본 {len(rows)}건", flush=True)

    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # 템플릿이 tools·tool_calls 를 모델 고유 형식(<tool_call><function=…>)으로 렌더한다.
    # 템플릿은 인자를 매핑으로 기대한다(문자열이면 `items` 필터에서 멈춘다) — JSON 문자열을 풀어 넘긴다.
    def render(row):
        messages = []
        for message in row["messages"]:
            message = dict(message)
            if message.get("tool_calls"):
                calls = []
                for call in message["tool_calls"]:
                    call = json.loads(json.dumps(call))
                    arguments = call.get("function", {}).get("arguments")
                    if isinstance(arguments, str):
                        try:
                            call["function"]["arguments"] = json.loads(arguments or "{}")
                        except json.JSONDecodeError:
                            call["function"]["arguments"] = {}
                    calls.append(call)
                message["tool_calls"] = calls
            messages.append(message)
        return tokenizer.apply_chat_template(messages, tools=row["tools"], tokenize=False)

    lengths = [len(tokenizer(render(r)).input_ids) for r in rows[: min(len(rows), 50)]]
    print(f"토큰 길이(앞 {len(lengths)}건): 최소 {min(lengths)} 최대 {max(lengths)} 평균 {sum(lengths)//len(lengths)}", flush=True)
    if max(lengths) > args.max_length:
        print(f"경고: 상한 {args.max_length} 를 넘는 표본이 있다 — 잘린다", flush=True)
    if args.dry_run:
        print(render(rows[0])[:1500])
        return

    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import AutoModelForImageTextToText, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    if not torch.cuda.is_available():
        sys.exit("CUDA 가 없다")
    free, total = torch.cuda.mem_get_info()
    print(f"VRAM 여유 {free/2**30:.1f}GB / {total/2**30:.1f}GB", flush=True)
    if free < 10 * 2**30:
        sys.exit("VRAM 여유가 10GB 미만이다. Ollama 모델을 내리고(ollama stop) 다시 돌려라")

    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForImageTextToText.from_pretrained(args.base, quantization_config=quant, dtype=torch.bfloat16, device_map={"": 0})
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
    model = to_bfloat16(model)
    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        # 언어 모델 층만. 비전 타워(visual.*)는 제외한다.
        target_modules=r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # 표본마다 제 길이로 둔다. 예전에는 전부 가장 긴 것에 맞춰 패딩했는데, 그러면 짧은 표본까지
    # 긴 표본의 값을 치른다 — 계획 표본(2,700 토큰)과 AIA 표본(1,250 토큰)을 섞으면 717 건이
    # 절벽 너머로 끌려가 17 시간이 된다. 고정 길이를 넣은 이유였던 Triton 커널 재컴파일은 그 커널
    # 패치를 걷어내면서 함께 사라졌다(README 의 길이 절)。 배치가 1 이라 패딩은 사실상 없다.
    encoded = [tokenizer(render(r), truncation=True, max_length=args.max_length) for r in rows]
    lengths_all = sorted(len(e.input_ids) for e in encoded)
    over = sum(1 for n in lengths_all if n > 2048)
    print(f"표본 길이: 최소 {lengths_all[0]} 중앙 {lengths_all[len(lengths_all) // 2]} 최대 {lengths_all[-1]}", flush=True)
    if over:
        print(f"경고: 2048 을 넘는 표본 {over}건 — 그 표본은 한 건에 100초 넘게 든다", flush=True)
    examples = [{
        "input_ids": list(e.input_ids),
        "attention_mask": [1] * len(e.input_ids),
        "labels": list(e.input_ids),
    } for e in encoded]
    dataset = Dataset.from_list(examples)

    def collate(features):
        """배치 안에서 가장 긴 것에 맞춰 패딩한다. 배치가 1 이면 패딩이 없다."""
        width = max(len(f["input_ids"]) for f in features)
        pad_id = tokenizer.pad_token_id
        batch = {"input_ids": [], "attention_mask": [], "labels": []}
        for f in features:
            gap = width - len(f["input_ids"])
            batch["input_ids"].append(list(f["input_ids"]) + [pad_id] * gap)
            batch["attention_mask"].append(list(f["attention_mask"]) + [0] * gap)
            # 패딩 자리는 손실에서 뺀다.
            batch["labels"].append(list(f["labels"]) + [-100] * gap)
        return {key: torch.tensor(value) for key, value in batch.items()}
    config = SFTConfig(
        output_dir=str(out / "checkpoints"),
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        gradient_checkpointing=True,
        max_length=args.max_length,
        logging_steps=1,
        save_strategy="no",
        bf16=True,
        lr_scheduler_type="cosine",
        warmup_steps=min(5, max(1, len(rows) // max(1, args.grad_accum) // 10)),
        report_to=[],
        packing=False,
        remove_unused_columns=False,
    )
    trainer = SFTTrainer(model=model, args=config, train_dataset=dataset, processing_class=tokenizer, data_collator=collate)
    started = time.time()
    result = trainer.train()
    print(f"학습 끝: {result.training_loss:.4f} loss, {int(time.time()-started)}초", flush=True)
    adapter = out / "adapter"
    trainer.model.save_pretrained(str(adapter))
    tokenizer.save_pretrained(str(adapter))
    (out / "train.json").write_text(json.dumps({
        "base": args.base, "samples": len(rows), "epochs": args.epochs, "lr": args.lr, "rank": args.rank,
        "max_length": args.max_length, "loss": result.training_loss, "seconds": int(time.time() - started),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.no_merge:
        return

    del trainer, model
    torch.cuda.empty_cache()
    merge_adapter(args.base, out, tokenizer)


if __name__ == "__main__":
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    main()
