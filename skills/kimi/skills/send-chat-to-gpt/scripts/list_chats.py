#!/usr/bin/env python3
"""List local Kimi Work conversations (title, time, conversation dir).

Usage:
    python list_chats.py [--grep KEYWORD] [--home KIMI_CODE_HOME]

Home precedence: --home, KIMI_CODE_HOME, then the existing APPDATA-based default.
Windows default: %APPDATA%/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home
"""
import argparse, glob, json, os, re, sys, datetime


def last_assistant_text(path):
    title = None
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"role":"assistant"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message", {}).get("message", obj)
                if msg.get("role") != "assistant":
                    continue
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "text" and c.get("text", "").strip():
                        title = c["text"].strip().splitlines()[0]
    except OSError:
        pass
    return title


def first_user_text(path, limit=60):
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if '"origin"' not in line or '"user"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "agent.message.appended":
                    continue
                wrapper = obj.get("message", {})
                meta = wrapper.get("meta", {})
                if (meta.get("origin") or {}).get("kind") != "user":
                    continue
                msg = wrapper.get("message", {})
                if msg.get("role") != "user":
                    continue
                for c in msg.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "text":
                        t = re.sub(r"<meta[^>]*/>", "", c["text"])
                        t = re.sub(r"<attachment>.*?</attachment>", "", t, flags=re.S).strip()
                        t = t.splitlines()[0] if t else ""
                        if t:
                            return t[:limit]
    except OSError:
        pass
    return ""


def wire_contains(path, keyword):
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            for line in f:
                if keyword in line:
                    return True
    except OSError:
        pass
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grep", help="按标题或内容关键词过滤")
    default_home = os.path.join(
        os.environ.get("APPDATA", ""), "kimi-desktop", "daimon-share", "daimon",
        "runtime", "kimi-code", "home")
    ap.add_argument("--home", default=os.environ.get("KIMI_CODE_HOME") or default_home,
                    help="kimi-code home 目录，优先于 KIMI_CODE_HOME")
    args = ap.parse_args()

    sessions_dir = os.path.join(glob.escape(os.path.expanduser(args.home)), "sessions")
    rows = []
    for conv_wire in glob.glob(os.path.join(sessions_dir, "*", "conv-*", "agents", "main", "wire.jsonl")):
        conv_dir = conv_wire[: -len(os.path.join("agents", "main", "wire.jsonl"))]
        sess_dir = os.path.dirname(conv_dir.rstrip(os.sep))
        title = None
        for ct in glob.glob(os.path.join(glob.escape(sess_dir), "ctitle-*", "agents", "main", "wire.jsonl")):
            title = last_assistant_text(ct) or title
        preview = first_user_text(conv_wire)
        mtime = os.path.getmtime(conv_wire)
        rows.append({"title": title or "(无标题)", "preview": preview,
                     "conv_dir": conv_dir.rstrip(os.sep), "mtime": mtime})

    if args.grep:
        kw = args.grep
        rows = [r for r in rows if kw in r["title"] or kw in r["preview"]
                or wire_contains(os.path.join(r["conv_dir"], "agents", "main", "wire.jsonl"), kw)]

    rows.sort(key=lambda r: r["mtime"], reverse=True)
    for r in rows:
        t = datetime.datetime.fromtimestamp(r["mtime"]).strftime("%Y-%m-%d %H:%M")
        print(f"{t}  {r['title']}")
        print(f"    首条: {r['preview']}")
        print(f"    目录: {r['conv_dir']}")
    print(f"\n共 {len(rows)} 个对话", file=sys.stderr)


if __name__ == "__main__":
    main()
