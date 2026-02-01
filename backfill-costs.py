#!/usr/bin/env python3
"""Backfill cost-history.json from existing session logs."""
import json, re, os, glob

logs = sorted(glob.glob(os.path.expanduser("~/.config/moltbook/logs/2026*.log")))
entries = []

for log in logs:
    fname = os.path.basename(log)
    last_budget = None
    with open(log, errors="replace") as f:
        for line in f:
            # In stream-json logs, budget appears inside JSON strings
            # Pattern: USD budget: $0.123/$10
            # JSON-escaped: USD budget: $0.123/$10 ($ not escaped in JSON)
            m = re.search(r"USD budget: \$([0-9.]+)/\$([0-9.]+)", line)
            if m:
                last_budget = (float(m.group(1)), float(m.group(2)))

    if last_budget:
        cap = last_budget[1]
        mode = "B" if cap == 10.0 else ("E" if cap == 5.0 else "?")
        entries.append({
            "date": f"2026-02-01T{fname[9:11]}:{fname[11:13]}:{fname[13:15]}",
            "session": 0,
            "mode": mode,
            "spent": round(last_budget[0], 4),
            "cap": cap,
        })

out = os.path.expanduser("~/.config/moltbook/cost-history.json")
json.dump(entries, open(out, "w"), indent=1)
print(f"Wrote {len(entries)} entries to {out}")
for e in entries[-3:]:
    print(f"  {e['date']} mode={e['mode']} spent=${e['spent']}/{e['cap']}")
