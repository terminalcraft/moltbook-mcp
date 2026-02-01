#!/usr/bin/env python3
"""Calculate session cost from token usage in stream-json logs.

Parses the final usage per assistant message and sums costs using
Claude API pricing. Works as both a standalone script and an importable module.

Usage:
  python3 calc-session-cost.py <log-file>              # human-readable
  python3 calc-session-cost.py <log-file> --json        # JSON output
  python3 calc-session-cost.py <log-file> --cost-only   # just the dollar amount
"""
import json, re, sys
from collections import defaultdict

# Claude pricing per 1M tokens (updated 2026-02)
# Opus 4.5: $5/$25, cache write $6.25, cache read $0.50
PRICING = {
    "claude-opus-4-5-20251101": {
        "input": 5.0, "output": 25.0, "cache_write": 6.25, "cache_read": 0.50,
    },
    "claude-sonnet-4-20250514": {
        "input": 3.0, "output": 15.0, "cache_write": 3.75, "cache_read": 0.30,
    },
    "claude-3-5-haiku-20241022": {
        "input": 0.80, "output": 4.0, "cache_write": 1.0, "cache_read": 0.08,
    },
}
DEFAULT_PRICING = PRICING["claude-opus-4-5-20251101"]


def calc_cost(log_file):
    """Parse a stream-json session log and return cost breakdown."""
    msgs = {}  # msg_id -> last usage seen
    model = None

    with open(log_file) as f:
        for line in f:
            line = line.strip()
            if not line.startswith('{'):
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue

            msg = obj.get("message", {})
            mid = msg.get("id")
            usage = msg.get("usage")
            if not mid or not usage:
                continue

            if not model:
                model = msg.get("model")

            # Keep last usage per message (cumulative within streaming)
            msgs[mid] = usage

    pricing = PRICING.get(model, DEFAULT_PRICING)

    total = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    for usage in msgs.values():
        total["input"] += usage.get("input_tokens", 0)
        total["output"] += usage.get("output_tokens", 0)
        total["cache_write"] += usage.get("cache_creation_input_tokens", 0)
        total["cache_read"] += usage.get("cache_read_input_tokens", 0)

    cost = sum(total[k] * pricing[k] / 1_000_000 for k in total)

    return {
        "model": model,
        "messages": len(msgs),
        "tokens": total,
        "cost_usd": round(cost, 4),
        "breakdown": {
            k: round(total[k] * pricing[k] / 1_000_000, 4) for k in total
        },
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <log-file> [--json|--cost-only]", file=sys.stderr)
        sys.exit(1)

    result = calc_cost(sys.argv[1])

    if "--cost-only" in sys.argv:
        print(f"${result['cost_usd']:.4f}")
    elif "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(f"Model: {result['model']}")
        print(f"API calls: {result['messages']}")
        print(f"Tokens: in={result['tokens']['input']}, out={result['tokens']['output']}, "
              f"cw={result['tokens']['cache_write']}, cr={result['tokens']['cache_read']}")
        print(f"Cost: ${result['cost_usd']:.4f}")
        b = result['breakdown']
        print(f"  Input: ${b['input']:.4f}, Output: ${b['output']:.4f}, "
              f"Cache write: ${b['cache_write']:.4f}, Cache read: ${b['cache_read']:.4f}")
