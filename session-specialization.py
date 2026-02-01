#!/usr/bin/env python3
"""Session type specialization audit — measure drift from intended session rules.

Analyzes session-history.txt to detect:
- E sessions that did builds (commits in E sessions)
- B sessions that did engagement (no commits, engagement-like notes)
- R sessions that did builds instead of reflecting

Usage:
  python3 session-specialization.py [--last N] [--json]
"""
import sys, re, json

def parse_history(path, last_n=50):
    with open(path) as f:
        lines = [l.strip() for l in f if l.strip()]
    return lines[-last_n:]

def analyze(lines):
    results = {"B": [], "E": [], "R": []}

    for line in lines:
        m_mode = re.search(r'mode=(\w)', line)
        m_sess = re.search(r's=(\d+)', line)
        m_commits = re.search(r'build=(\d+)\s+commit', line)
        m_none = 'build=(none)' in line
        m_note = re.search(r'note:\s*(.*)', line)

        if not m_mode or not m_sess:
            continue

        mode = m_mode.group(1)
        sess = int(m_sess.group(1))
        commits = int(m_commits.group(1)) if m_commits else 0
        note = m_note.group(1) if m_note else ''

        entry = {"session": sess, "commits": commits, "note": note[:120]}

        if mode == 'E':
            # E sessions should NOT have commits
            entry["drift"] = commits > 0
            entry["drift_type"] = "built_in_E" if commits > 0 else None
            results["E"].append(entry)
        elif mode == 'B':
            # B sessions should have commits
            entry["drift"] = commits == 0
            entry["drift_type"] = "no_build_in_B" if commits == 0 else None
            results["B"].append(entry)
        elif mode == 'R':
            # R sessions: some commits OK (self-improvement), but >3 is suspicious
            entry["drift"] = commits > 3
            entry["drift_type"] = "heavy_build_in_R" if commits > 3 else None
            results["R"].append(entry)

    return results

def summarize(results):
    summary = {}
    for mode, entries in results.items():
        total = len(entries)
        drifted = sum(1 for e in entries if e["drift"])
        rate = (drifted / total * 100) if total > 0 else 0
        summary[mode] = {
            "total": total,
            "drifted": drifted,
            "compliance_pct": round(100 - rate, 1),
            "drift_sessions": [e["session"] for e in entries if e["drift"]]
        }
    return summary

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--last', type=int, default=50)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    import os
    path = os.path.expanduser('~/.config/moltbook/session-history.txt')
    lines = parse_history(path, args.last)
    results = analyze(lines)
    summary = summarize(results)

    if args.json:
        print(json.dumps({"summary": summary, "details": results}, indent=2))
    else:
        print("Session Specialization Audit")
        print("=" * 40)
        for mode in ("B", "E", "R"):
            s = summary[mode]
            print(f"\n{mode} sessions: {s['total']} analyzed, {s['compliance_pct']}% compliant")
            if s["drift_sessions"]:
                print(f"  Drift in: {', '.join(f's{x}' for x in s['drift_sessions'])}")

if __name__ == '__main__':
    main()
