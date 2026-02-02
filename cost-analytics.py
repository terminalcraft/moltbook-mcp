#!/usr/bin/env python3
"""Session cost analytics — analyze spending patterns by mode, detect outliers, show trends."""

import json
import sys
from pathlib import Path
from collections import defaultdict
import statistics

COST_HISTORY = Path.home() / ".config/moltbook/cost-history.json"
SESSION_HISTORY = Path.home() / ".config/moltbook/session-history.txt"

def load_costs():
    with open(COST_HISTORY) as f:
        return json.load(f)

def parse_session_history():
    """Parse session-history.txt for duration and commit data."""
    sessions = {}
    with open(SESSION_HISTORY) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = {}
            # Extract s=NNN
            if ' s=' in line:
                s_part = line.split(' s=')[1].split(' ')[0]
                try:
                    session_num = int(s_part)
                except ValueError:
                    continue
                parts['session'] = session_num
            else:
                continue
            # Extract cost
            if 'cost=$' in line:
                cost_str = line.split('cost=$')[1].split(' ')[0]
                try:
                    parts['cost'] = float(cost_str)
                except ValueError:
                    pass
            # Extract duration
            if 'dur=' in line:
                parts['dur'] = line.split('dur=')[1].split(' ')[0]
            # Extract mode
            if 'mode=' in line:
                parts['mode'] = line.split('mode=')[1].split(' ')[0]
            # Extract commit count
            if 'build=' in line:
                build_str = line.split('build=')[1].split(' ')[0]
                try:
                    parts['commits'] = int(build_str)
                except ValueError:
                    parts['commits'] = 0
            # Extract note
            if 'note:' in line:
                parts['note'] = line.split('note:')[1].strip()
            sessions[session_num] = parts
    return sessions

def analyze():
    costs = load_costs()
    history = parse_session_history()

    # Group by mode
    by_mode = defaultdict(list)
    for entry in costs:
        mode = entry.get('mode', '?')
        spent = entry.get('spent', 0)
        by_mode[mode].append(spent)

    print("=" * 60)
    print("SESSION COST ANALYTICS")
    print("=" * 60)

    # Per-mode stats
    print("\n--- Cost by Session Type ---")
    total_all = 0
    for mode in sorted(by_mode.keys()):
        vals = by_mode[mode]
        total = sum(vals)
        total_all += total
        avg = statistics.mean(vals)
        med = statistics.median(vals)
        mx = max(vals)
        mn = min(vals)
        std = statistics.stdev(vals) if len(vals) > 1 else 0
        print(f"\n  {mode} sessions ({len(vals)} total):")
        print(f"    Total: ${total:.2f}  |  Avg: ${avg:.2f}  |  Median: ${med:.2f}")
        print(f"    Min: ${mn:.2f}  |  Max: ${mx:.2f}  |  StdDev: ${std:.2f}")

    print(f"\n  TOTAL SPEND: ${total_all:.2f} across {len(costs)} sessions")
    print(f"  Avg per session: ${total_all/len(costs):.2f}")

    # Outlier detection (>2 stddev from mode mean)
    print("\n--- Outliers (>2σ from mode mean) ---")
    outlier_count = 0
    for entry in costs:
        mode = entry.get('mode', '?')
        spent = entry.get('spent', 0)
        vals = by_mode[mode]
        if len(vals) < 3:
            continue
        avg = statistics.mean(vals)
        std = statistics.stdev(vals)
        if std > 0 and spent > avg + 2 * std:
            session = entry.get('session', '?')
            note = history.get(session, {}).get('note', '')
            print(f"  s{session} ({mode}): ${spent:.2f} (avg=${avg:.2f}, +{((spent-avg)/std):.1f}σ)")
            if note:
                print(f"    → {note[:80]}")
            outlier_count += 1
    if outlier_count == 0:
        print("  None found.")

    # Cost efficiency: cost per commit (from session history)
    print("\n--- Cost Efficiency (recent sessions) ---")
    sessions_with_commits = []
    for snum, data in history.items():
        commits = data.get('commits', 0)
        cost = data.get('cost')
        if cost and commits and commits > 0:
            sessions_with_commits.append({
                'session': snum,
                'cost': cost,
                'commits': commits,
                'cpc': cost / commits,
                'mode': data.get('mode', '?'),
                'note': data.get('note', '')
            })

    if sessions_with_commits:
        sessions_with_commits.sort(key=lambda x: x['cpc'])
        avg_cpc = statistics.mean([s['cpc'] for s in sessions_with_commits])
        print(f"  Avg cost/commit: ${avg_cpc:.2f} ({len(sessions_with_commits)} sessions)")
        print(f"\n  Most efficient:")
        for s in sessions_with_commits[:3]:
            print(f"    s{s['session']}: ${s['cpc']:.2f}/commit ({s['commits']}c, ${s['cost']:.2f})")
        print(f"\n  Least efficient:")
        for s in sessions_with_commits[-3:]:
            print(f"    s{s['session']}: ${s['cpc']:.2f}/commit ({s['commits']}c, ${s['cost']:.2f})")

    # Recent trend (last 20 sessions)
    print("\n--- Recent Trend (last 20) ---")
    recent = costs[-20:]
    first_half = [e['spent'] for e in recent[:10]]
    second_half = [e['spent'] for e in recent[10:]]
    avg1 = statistics.mean(first_half)
    avg2 = statistics.mean(second_half)
    direction = "↑" if avg2 > avg1 else "↓"
    pct = abs(avg2 - avg1) / avg1 * 100 if avg1 > 0 else 0
    print(f"  Older 10 avg: ${avg1:.2f}  →  Newer 10 avg: ${avg2:.2f}  ({direction} {pct:.0f}%)")

    # Mode distribution
    print("\n--- Spend Distribution ---")
    for mode in sorted(by_mode.keys()):
        pct = sum(by_mode[mode]) / total_all * 100
        bar = "█" * int(pct / 2)
        print(f"  {mode}: {pct:5.1f}% {bar}")

    # Output JSON summary for programmatic use
    if '--json' in sys.argv:
        summary = {
            'total_spend': round(total_all, 2),
            'sessions': len(costs),
            'avg_per_session': round(total_all / len(costs), 2),
            'by_mode': {m: {'count': len(v), 'total': round(sum(v), 2), 'avg': round(statistics.mean(v), 2)}
                       for m, v in by_mode.items()},
            'outlier_count': outlier_count
        }
        print(f"\n--- JSON Summary ---\n{json.dumps(summary, indent=2)}")

if __name__ == '__main__':
    analyze()
