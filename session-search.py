#!/usr/bin/env python3
"""Search across Claude Code JSONL session logs.

Searches tool calls, assistant messages, and tool results for keywords.
Supports filtering by tool name, session, and date range.

Usage:
  python3 session-search.py "keyword"                    # Search all logs
  python3 session-search.py "keyword" --tool Bash         # Filter by tool
  python3 session-search.py "keyword" --last 10           # Last N sessions
  python3 session-search.py "keyword" --json              # JSON output
"""

import json, sys, os, re, argparse
from pathlib import Path
from datetime import datetime

LOGS_DIR = Path.home() / ".claude" / "projects" / "-home-moltbot"

def parse_args():
    p = argparse.ArgumentParser(description="Search session logs")
    p.add_argument("query", help="Search keyword or regex")
    p.add_argument("--tool", help="Filter by tool name (e.g. Bash, Edit, Read)")
    p.add_argument("--last", type=int, default=20, help="Search last N sessions (default 20)")
    p.add_argument("--json", action="store_true", help="JSON output")
    p.add_argument("--context", type=int, default=0, help="Show N chars of context around match")
    return p.parse_args()

def get_recent_logs(n):
    """Get the N most recent JSONL log files by modification time."""
    logs = sorted(LOGS_DIR.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True)
    return logs[:n]

def extract_text(entry):
    """Extract searchable text from a JSONL entry."""
    t = entry.get("type", "")
    texts = []
    tool_name = None

    if t == "assistant":
        msg = entry.get("message", {})
        for block in msg.get("content", []):
            if isinstance(block, str):
                texts.append(block)
            elif isinstance(block, dict):
                if block.get("type") == "text":
                    texts.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    tool_name = block.get("name", "")
                    inp = block.get("input", {})
                    # Extract command, file_path, pattern, etc.
                    for k in ("command", "file_path", "pattern", "content", "prompt", "old_string", "new_string", "query"):
                        if k in inp:
                            texts.append(str(inp[k]))
    elif t == "tool_result":
        content = entry.get("content", "")
        if isinstance(content, str):
            texts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(item.get("text", ""))

    return tool_name, "\n".join(texts)

def search_file(path, pattern, tool_filter):
    """Search a single JSONL file, return matches."""
    matches = []
    try:
        with open(path) as f:
            for i, line in enumerate(f):
                try:
                    entry = json.loads(line.strip())
                except json.JSONDecodeError:
                    continue

                tool_name, text = extract_text(entry)
                if not text:
                    continue

                if tool_filter and tool_name != tool_filter:
                    # Also check tool_result entries — they don't have tool_name
                    if entry.get("type") != "tool_result":
                        continue

                if re.search(pattern, text, re.IGNORECASE):
                    ts = entry.get("timestamp", "")
                    matches.append({
                        "session": path.stem,
                        "line": i + 1,
                        "type": entry.get("type", "unknown"),
                        "tool": tool_name or "",
                        "timestamp": ts,
                        "snippet": text[:500],
                    })
    except Exception as e:
        pass
    return matches

def main():
    args = parse_args()
    logs = get_recent_logs(args.last)

    if not logs:
        print("No session logs found.")
        sys.exit(1)

    all_matches = []
    for log in logs:
        matches = search_file(log, args.query, args.tool)
        all_matches.extend(matches)

    # Cap results
    all_matches = all_matches[:100]

    if args.json:
        print(json.dumps({"query": args.query, "matches": len(all_matches), "results": all_matches}, indent=2))
    else:
        print(f"Query: {args.query} | Searched: {len(logs)} sessions | Matches: {len(all_matches)}\n")
        for m in all_matches[:30]:
            snippet = m["snippet"][:200].replace("\n", " ")
            tool_str = f" [{m['tool']}]" if m["tool"] else ""
            print(f"  {m['session'][:8]}… L{m['line']} {m['type']}{tool_str}")
            print(f"    {snippet}")
            print()

if __name__ == "__main__":
    main()
