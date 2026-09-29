"""시험 몫을 학습에 쓴 그대로의 환경에서 생성해 낸다(M11).

    .venv/Scripts/python local-llm-dev/finetune/generate-hf.py \
        --data local-llm-dev/finetune/data/sft-aia-holdout.jsonl \
        --adapter local-llm-dev/finetune/runs/aia-r1/adapter \
        --out .tuning/aia-r1-gen.jsonl

왜 Ollama 가 아닌가: Ollama 0.34 는 Windows 에서 safetensors 를 가져올 때 양자화에 MLX 를 찾는데
그것은 Apple 전용이라 없다. 양자화 없이 올리면 19GB 라 12GB 한 장에 안 올라간다. 그래서 학습에
쓴 4비트 경로 그대로 생성해 낸다. 서빙 층(Ollama)의 차이는 여기서 재지 않는다 — 배포는 따로다.

무엇을 하지 않나: 채점하지 않는다. 생성물만 내고 채점은 `eval-aia.mjs --generated` 가 한다.
채점 규칙이 두 벌로 갈라지면 어느 쪽이 맞는지 알 수 없기 때문이다.
"""
import argparse
import json
import pathlib
import re
import sys
import time


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--base", default="Qwen/Qwen3.5-9B")
    p.add_argument("--adapter", default=None, help="비우면 기준 모델 그대로 — 견줄 바닥을 낸다")
    p.add_argument("--out", required=True)
    p.add_argument("--max-new-tokens", type=int, default=256)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--thinking", action="store_true", help="사고 기록을 켜고 생성한다. 기본은 끔 — 학습 표본이 빈 사고 기록으로 구워졌다")
    return p.parse_args()


CALL = re.compile(r"<tool_call>\s*<function=([^>]+)>(.*?)</function>\s*</tool_call>", re.S)
PARAM = re.compile(r"<parameter=([^>]+)>\n?(.*?)\n?</parameter>", re.S)


def parse_tool_calls(text):
    """모델이 낸 <tool_call><function=…><parameter=…> 를 OpenAI 모양으로 편다.

    인자 값은 글자다. `arguments` 자리처럼 JSON 이 들어오는 칸은 풀어서 담고, 못 풀면 글자
    그대로 둔다 — 못 푼 것도 채점이 봐야 할 사실이다.
    """
    calls = []
    for name, body in CALL.findall(text):
        args = {}
        for key, value in PARAM.findall(body):
            value = value.strip()
            try:
                args[key.strip()] = json.loads(value)
            except json.JSONDecodeError:
                args[key.strip()] = value
        calls.append({"type": "function", "function": {"name": name.strip(), "arguments": json.dumps(args, ensure_ascii=False)}})
    return calls


def strip_thinking(text):
    return re.sub(r"^\s*<think>.*?</think>\s*", "", text, flags=re.S)


def to_template_messages(messages):
    out = []
    for message in messages:
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
        out.append(message)
    return out


def main():
    args = parse_args()
    rows = [json.loads(line) for line in open(args.data, encoding="utf-8") if line.strip()]
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        sys.exit("시험 표본이 없다")

    import torch
    from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForImageTextToText.from_pretrained(args.base, quantization_config=quant, dtype=torch.bfloat16, device_map={"": 0})
    if args.adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, args.adapter)
        print(f"어댑터: {args.adapter}", flush=True)
    else:
        print("어댑터 없음 — 기준 모델", flush=True)
    model.eval()

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with out.open("w", encoding="utf-8") as sink:
        for i, row in enumerate(rows):
            prompt = tokenizer.apply_chat_template(
                to_template_messages(row["messages"][:-1]), tools=row.get("tools"),
                tokenize=False, add_generation_prompt=True, enable_thinking=args.thinking,
            )
            ids = tokenizer(prompt, return_tensors="pt").to("cuda")
            with torch.no_grad():
                generated = model.generate(**ids, max_new_tokens=args.max_new_tokens, do_sample=False, pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id)
            text = tokenizer.decode(generated[0][ids.input_ids.shape[1]:], skip_special_tokens=True)
            body = strip_thinking(text)
            sink.write(json.dumps({"index": i, "task": row["meta"]["task"], "content": body, "tool_calls": parse_tool_calls(body)}, ensure_ascii=False) + "\n")
            if (i + 1) % 10 == 0:
                print(f"{i + 1}/{len(rows)} ({int(time.time() - started)}초)", flush=True)
    print(f"생성 끝: {len(rows)}건 {int(time.time() - started)}초 → {out}", flush=True)


if __name__ == "__main__":
    main()
