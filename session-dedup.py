#!/usr/bin/env python3
"""Analyze recent session logs for repeated tool calls across sessions.

Outputs a dedup report: which Read/Grep/Glob calls happen in >50% of recent
sessions. This hints at files/patterns that could be cached or pre-loaded.

Usage: python3 session-dedup.py [--sessions N] [--output hints|report]
"""

import json, os, sys, glob, argparse
from collections import Counter, defaultdict
from pathlib import Path

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects" / "-home-moltbot"
DEDUP_TOOLS = {"Read", "Grep", "Glob", "Bash"}  # tools worth deduplicating


def extract_tool_calls(jsonl_path):
    """Extract tool calls from a session JSONL file."""
    calls = []
    try:
        with open(jsonl_path) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                    if obj.get("type") == "assistant" and obj.get("message", {}).get("content"):
                        for block in obj["message"]["content"]:
                            if block.get("type") == "tool_use" and block.get("name") in DEDUP_TOOLS:
                                inp = block.get("input", {})
                                calls.append({
                                    "tool": block["name"],
                                    "key": normalize_call(block["name"], inp),
                                    "input": inp,
                                })
                except (json.JSONDecodeError, KeyError):
                    pass
    except Exception:
        pass
    return calls


def normalize_call(tool, inp):
    """Create a normalized key for dedup comparison."""
    if tool == "Read":
        return f"Read:{inp.get('file_path', '')}"
    elif tool == "Grep":
        return f"Grep:{inp.get('pattern', '')}@{inp.get('path', '.')}"
    elif tool == "Glob":
        return f"Glob:{inp.get('pattern', '')}@{inp.get('path', '.')}"
    elif tool == "Bash":
        cmd = inp.get("command", "")
        # Only track short, likely-repeated commands
        if len(cmd) > 120:
            return None
        return f"Bash:{cmd[:80]}"
    return None


def analyze_sessions(n_sessions=20):
    """Analyze the N most recent session logs."""
    logs = sorted(CLAUDE_PROJECTS.glob("*.jsonl"), key=os.path.getmtime, reverse=True)[:n_sessions]

    if not logs:
        print("No session logs found.", file=sys.stderr)
        return {}, 0

    # Track which calls appear in which sessions
    call_sessions = defaultdict(set)  # key -> set of session indices
    call_examples = {}  # key -> example input

    for idx, log_path in enumerate(logs):
        calls = extract_tool_calls(log_path)
        for call in calls:
            key = call["key"]
            if key is None:
                continue
            call_sessions[key].add(idx)
            if key not in call_examples:
                call_examples[key] = call["input"]

    return call_sessions, len(logs), call_examples


def main():
    parser = argparse.ArgumentParser(description="Session dedup analysis")
    parser.add_argument("--sessions", type=int, default=20, help="Number of recent sessions to analyze")
    parser.add_argument("--output", choices=["hints", "report"], default="report")
    parser.add_argument("--threshold", type=float, default=0.3, help="Min fraction of sessions a call must appear in")
    args = parser.parse_args()

    call_sessions, total, call_examples = analyze_sessions(args.sessions)
    if total == 0:
        return

    # Filter to calls appearing in >= threshold fraction of sessions
    repeated = {k: v for k, v in call_sessions.items() if len(v) / total >= args.threshold}
    sorted_calls = sorted(repeated.items(), key=lambda x: -len(x[1]))

    if args.output == "report":
        print(f"Analyzed {total} sessions. Found {len(sorted_calls)} repeated patterns (>={args.threshold*100:.0f}% of sessions):\n")
        for key, sessions in sorted_calls[:30]:
            pct = len(sessions) / total * 100
            print(f"  {pct:5.1f}%  ({len(sessions):2d}/{total})  {key}")

        # Summary by tool type
        print("\nBy tool:")
        tool_counts = Counter()
        for key, _ in sorted_calls:
            tool = key.split(":")[0]
            tool_counts[tool] += 1
        for tool, count in tool_counts.most_common():
            print(f"  {tool}: {count} repeated patterns")

    elif args.output == "hints":
        # Output a JSON hints file for pre-hooks
        hints = []
        for key, sessions in sorted_calls[:20]:
            hints.append({
                "key": key,
                "frequency": f"{len(sessions)}/{total}",
                "example": call_examples.get(key, {}),
            })
        json.dump({"total_sessions": total, "threshold": args.threshold, "hints": hints}, sys.stdout, indent=2)
        print()


if __name__ == "__main__":
    main()
