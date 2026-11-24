#!/usr/bin/env python3
"""Trim a chat-context Markdown to the newest N chars (whole-message granularity).

Usage:
    python truncate_context.py <context.md> [--max-chars 8000]

Keeps the header and the newest `## 用户/## Kimi` sections that fit the budget;
drops oldest sections first and marks the omission. Overwrites the file in place.
Prints stats; the agent only needs the stats, not the file contents.
"""
import argparse, re, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--max-chars", type=int, default=8000)
    args = ap.parse_args()

    text = open(args.path, encoding="utf-8").read()
    if len(text) <= args.max_chars:
        print(f"chars={len(text)} 未超限，无需截取")
        return

    # 头部（第一个 ## 之前）+ 按消息分节
    m = re.search(r"\n## ", text)
    header = text[:m.start()] if m else ""
    body = text[m.start():] if m else text
    sections = re.split(r"(?=\n## )", body)
    sections = [s for s in sections if s.strip()]

    note = "\n\n> （注：原对话较长，较早部分已省略，以下仅保留最近的对话内容。）\n"
    budget = args.max_chars - len(header) - len(note)

    kept = []
    total = 0
    for s in reversed(sections):
        if total + len(s) > budget and kept:
            break
        kept.insert(0, s)
        total += len(s)

    out = header + note + "".join(kept)
    open(args.path, "w", encoding="utf-8").write(out)
    print(f"原 {len(text)} 字符 / {len(sections)} 条消息 -> 截取后 {len(out)} 字符 / 保留最近 {len(kept)} 条")

if __name__ == "__main__":
    main()
