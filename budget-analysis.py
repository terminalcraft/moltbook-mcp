#!/usr/bin/env python3
"""Session budget analysis — per-tool-call cost breakdown from Claude Code JSONL logs.

Usage:
  python3 budget-analysis.py [--sessions N] [--json] [--by-tool] [--by-session]

Parses Claude Code conversation logs, extracts token usage per assistant turn,
maps costs to tool calls, and reports per-tool and per-session breakdowns.

Pricing (Opus 4.5 as of 2025):
  Input:  $15/1M tokens
  Output: $75/1M tokens
  Cache write: $18.75/1M tokens
  Cache read:  $1.50/1M tokens
"""

import json, glob, os, sys, argparse
from collections import defaultdict
from pathlib import Path

LOGS_DIR = Path.home() / ".claude/projects/-home-moltbot"
INDEX_FILE = LOGS_DIR / "sessions-index.json"

# Opus 4.5 pricing per million tokens
PRICE_INPUT = 15.0
PRICE_OUTPUT = 75.0
PRICE_CACHE_WRITE = 18.75
PRICE_CACHE_READ = 1.50

def token_cost(usage):
    """Calculate dollar cost from a usage dict."""
    inp = usage.get("input_tokens", 0)
    out = usage.get("output_tokens", 0)
    cw = usage.get("cache_creation_input_tokens", 0)
    cr = usage.get("cache_read_input_tokens", 0)
    return (
        (inp * PRICE_INPUT / 1_000_000) +
        (out * PRICE_OUTPUT / 1_000_000) +
        (cw * PRICE_CACHE_WRITE / 1_000_000) +
        (cr * PRICE_CACHE_READ / 1_000_000)
    )

def extract_tools_from_content(content):
    """Extract tool names from assistant message content blocks."""
    tools = []
    if not isinstance(content, list):
        return tools
    for block in content:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            tools.append(block.get("name", "unknown"))
    return tools

def analyze_session(jsonl_path):
    """Analyze a single session JSONL file. Returns per-tool cost breakdown."""
    per_tool = defaultdict(lambda: {"cost": 0, "calls": 0, "input_tokens": 0, "output_tokens": 0})
    total_cost = 0
    turns = 0

    with open(jsonl_path) as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") != "assistant":
                continue

            msg = entry.get("message", {})
            usage = msg.get("usage", {})
            if not usage:
                continue

            cost = token_cost(usage)
            total_cost += cost
            turns += 1

            tools = extract_tools_from_content(msg.get("content", []))
            if tools:
                # Distribute turn cost equally among tools used in this turn
                per_tool_cost = cost / len(tools)
                for tool in tools:
                    per_tool[tool]["cost"] += per_tool_cost
                    per_tool[tool]["calls"] += 1
                    per_tool[tool]["input_tokens"] += usage.get("input_tokens", 0) // len(tools)
                    per_tool[tool]["output_tokens"] += usage.get("output_tokens", 0) // len(tools)
            else:
                # Text-only turn (thinking/responding)
                per_tool["_text"]["cost"] += cost
                per_tool["_text"]["calls"] += 1
                per_tool["_text"]["input_tokens"] += usage.get("input_tokens", 0)
                per_tool["_text"]["output_tokens"] += usage.get("output_tokens", 0)

    return {"total_cost": total_cost, "turns": turns, "per_tool": dict(per_tool)}

def get_recent_sessions(n=20):
    """Get the N most recent session JSONL files."""
    files = sorted(LOGS_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:n]

def main():
    parser = argparse.ArgumentParser(description="Session budget analysis")
    parser.add_argument("--sessions", type=int, default=10, help="Number of recent sessions to analyze")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument("--by-tool", action="store_true", help="Aggregate by tool across all sessions")
    parser.add_argument("--by-session", action="store_true", help="Show per-session breakdown")
    args = parser.parse_args()

    sessions = get_recent_sessions(args.sessions)
    if not sessions:
        print("No session logs found.")
        return

    all_results = []
    agg_tools = defaultdict(lambda: {"cost": 0, "calls": 0, "sessions": 0})

    for sf in sessions:
        result = analyze_session(sf)
        result["file"] = sf.name
        all_results.append(result)
        for tool, data in result["per_tool"].items():
            agg_tools[tool]["cost"] += data["cost"]
            agg_tools[tool]["calls"] += data["calls"]
            agg_tools[tool]["sessions"] += 1

    if args.json:
        output = {
            "sessions_analyzed": len(all_results),
            "total_cost": sum(r["total_cost"] for r in all_results),
            "by_tool": {k: {"cost": round(v["cost"], 4), "calls": v["calls"], "sessions": v["sessions"],
                            "avg_cost_per_call": round(v["cost"] / v["calls"], 4) if v["calls"] else 0}
                       for k, v in sorted(agg_tools.items(), key=lambda x: -x[1]["cost"])},
        }
        if args.by_session:
            output["by_session"] = [{
                "file": r["file"],
                "cost": round(r["total_cost"], 4),
                "turns": r["turns"],
                "top_tools": sorted(r["per_tool"].items(), key=lambda x: -x[1]["cost"])[:5]
            } for r in all_results]
        print(json.dumps(output, indent=2))
        return

    # Text output
    total = sum(r["total_cost"] for r in all_results)
    print(f"Budget Analysis — {len(all_results)} sessions, ${total:.4f} total\n")

    if args.by_tool or not args.by_session:
        print("Per-tool cost breakdown (aggregated):")
        print(f"  {'Tool':<35} {'Cost':>8} {'Calls':>6} {'$/call':>8}")
        print(f"  {'-'*35} {'-'*8} {'-'*6} {'-'*8}")
        for tool, data in sorted(agg_tools.items(), key=lambda x: -x[1]["cost"]):
            avg = data["cost"] / data["calls"] if data["calls"] else 0
            print(f"  {tool:<35} ${data['cost']:>7.4f} {data['calls']:>6} ${avg:>7.4f}")
        print()

    if args.by_session:
        print("Per-session breakdown:")
        for r in all_results:
            print(f"\n  {r['file']} — ${r['total_cost']:.4f} ({r['turns']} turns)")
            for tool, data in sorted(r["per_tool"].items(), key=lambda x: -x[1]["cost"])[:5]:
                print(f"    {tool:<33} ${data['cost']:.4f} ({data['calls']} calls)")

if __name__ == "__main__":
    main()
