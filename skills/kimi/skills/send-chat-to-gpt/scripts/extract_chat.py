#!/usr/bin/env python3
"""Export a Kimi Work conversation (wire.jsonl event log) to a clean Markdown transcript.

Usage:
    python extract_chat.py <conv_dir_or_wire.jsonl> -o output.md [--title TITLE]

Keeps only real user prompts and assistant text; drops think/tool/system/skill noise.
"""
import argparse, json, os, re, sys


def resolve_wire(path):
    if path.endswith(".jsonl"):
        return path
    cand = os.path.join(path, "agents", "main", "wire.jsonl")
    if os.path.isfile(cand):
        return cand
    sys.exit(f"找不到 wire.jsonl: {cand}")


NOISE_PATTERNS = ("<skill-loaded", "<system-reminder>", "Skill tool loaded instructions")


def extract(wire_path):
    turns = []
    with open(wire_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "agent.message.appended":
                continue
            wrapper = obj.get("message", {})
            msg = wrapper.get("message", {})
            meta = wrapper.get("meta", {})
            role = msg.get("role")
            origin = (meta.get("origin") or {}).get("kind")
            if role == "user" and origin != "user":
                continue  # 系统注入、日期提醒等
            if role != "assistant" and role != "user":
                continue  # 工具结果等
            parts = [c.get("text", "") for c in (msg.get("content") or [])
                     if isinstance(c, dict) and c.get("type") == "text"]
            text = "\n".join(p for p in parts if p).strip()
            if not text:
                continue
            text = re.sub(r"<meta[^>]*/>\s*", "", text)
            text = re.sub(r'<attachment>\s*(\{.*?\})\s*</attachment>',
                          lambda m: _fmt_attachment(m.group(1)), text)
            text = text.strip()
            if not text or any(p in text for p in NOISE_PATTERNS):
                continue
            turns.append((role, text))
    return turns


def _fmt_attachment(raw):
    try:
        att = json.loads(raw)
        return f"[附件: {att.get('name', '未知文件')}]"
    except Exception:
        return "[附件]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="conv-* 目录或 wire.jsonl 路径")
    ap.add_argument("-o", "--output", required=True, help="输出 Markdown 路径")
    ap.add_argument("--title", default="对话上下文")
    args = ap.parse_args()

    turns = extract(resolve_wire(args.source))
    md = [f"# {args.title}\n", "以下是从 Kimi 导出的完整对话记录，请作为我们的对话历史。\n"]
    for role, text in turns:
        who = "用户" if role == "user" else "Kimi"
        md.append(f"\n## {who}\n\n{text}\n")
    with open(args.output, "w", encoding="utf-8") as f:
        f.write("\n".join(md))
    print(f"turns={len(turns)} -> {args.output}")


if __name__ == "__main__":
    main()
