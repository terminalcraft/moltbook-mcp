#!/usr/bin/env python3
"""Cost analysis pipeline — anomaly detection, trend analysis, budget utilization, nudge.

Extracted from hooks/post-session/15-cost-pipeline.sh (R#304).
Called with: python3 scripts/cost-analysis.py <cost_file> <trend_file> <util_file> <nudge_file> <directive_file> <mode> <session_num> <spent>
Env: WQ_TASK_ID, COMMIT_COUNT
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime

CAPS = {"B": 10, "E": 5, "R": 5}


def load_cost_data(cost_file):
    return json.load(open(cost_file))


def detect_anomaly(data, mode, session_num, this_cost, directive_file):
    """Step 2: flag sessions costing 2x+ the mode average."""
    mode_costs = [
        e["cost"]
        for e in data
        if e["mode"] == mode
        and e["session"] != session_num
        and not e.get("deprecated")
    ]
    if len(mode_costs) < 5:
        return

    avg = sum(mode_costs) / len(mode_costs)
    ratio = this_cost / avg if avg > 0 else 0
    threshold = avg * 2

    wq_task = os.environ.get("WQ_TASK_ID", "")
    commit_count = int(os.environ.get("COMMIT_COUNT", "0"))

    if this_cost >= threshold:
        task_info = (
            f" task={wq_task} commits={commit_count}"
            if wq_task
            else f" commits={commit_count}"
        )
        print(
            f"\u26a0 cost-anomaly: s{session_num} ${this_cost:.2f} is {ratio:.1f}x "
            f"{mode}-mode avg ${avg:.2f}{task_info}"
        )
        # Write alert for next session
        alert_file = os.path.expanduser("~/.config/moltbook/cost-alert.txt")
        with open(alert_file, "w") as af:
            af.write(
                f"## COST ALERT\n"
                f"Last session (s{session_num}, mode {mode}) cost ${this_cost:.2f} "
                f"-- {ratio:.1f}x the {mode}-mode average of ${avg:.2f}.{task_info}\n"
                f"Watch your budget this session.\n"
            )
        # Log to directives.json
        try:
            dt = json.load(open(directive_file))
            compliance = dt.setdefault("compliance", {})
            if "cost_anomaly" not in compliance:
                compliance["cost_anomaly"] = {
                    "description": "Flag sessions costing 2x+ the mode average",
                    "anomalies": [],
                    "total_flagged": 0,
                }
            ca = compliance["cost_anomaly"]
            ca["anomalies"] = ca.get("anomalies", [])[-19:]
            anomaly_entry = {
                "session": session_num,
                "mode": mode,
                "cost": this_cost,
                "avg": round(avg, 4),
                "ratio": round(ratio, 1),
                "date": datetime.now().isoformat(),
            }
            if wq_task:
                anomaly_entry["task"] = wq_task
            if commit_count:
                anomaly_entry["commits"] = commit_count
            ca["anomalies"].append(anomaly_entry)
            ca["total_flagged"] = ca.get("total_flagged", 0) + 1
            ca["last_flagged_session"] = session_num
            with open(directive_file, "w") as f:
                json.dump(dt, f, indent=2)
                f.write("\n")
        except Exception:
            pass
    else:
        print(
            f"cost-anomaly: s{session_num} ${this_cost:.2f} OK "
            f"({ratio:.1f}x avg ${avg:.2f})"
        )


def analyze_trends(data, session_num, trend_file):
    """Step 3: compute per-mode cost trends."""
    clean_data = [e for e in data if not e.get("deprecated")]
    if len(clean_data) < 10:
        return

    by_mode = defaultdict(list)
    for e in clean_data:
        by_mode[e["mode"]].append(e["cost"])

    trends = {
        "generated": datetime.now().isoformat(),
        "session": session_num,
        "modes": {},
        "warnings": [],
    }
    for m, costs in by_mode.items():
        n = len(costs)
        overall_avg = sum(costs) / n
        recent_10 = costs[-10:] if n >= 10 else costs
        recent_10_avg = sum(recent_10) / len(recent_10)
        entry = {
            "total_sessions": n,
            "overall_avg": round(overall_avg, 4),
            "recent_10_avg": round(recent_10_avg, 4),
            "min": round(min(costs), 4),
            "max": round(max(costs), 4),
        }
        if n >= 20:
            baseline_avg = sum(costs[:-10]) / len(costs[:-10])
            entry["baseline_avg"] = round(baseline_avg, 4)
            drift_pct = (
                ((recent_10_avg - baseline_avg) / baseline_avg * 100)
                if baseline_avg > 0
                else 0
            )
            entry["drift_pct"] = round(drift_pct, 1)
            entry["status"] = (
                "creeping"
                if drift_pct > 25
                else ("improving" if drift_pct < -25 else "stable")
            )
            if drift_pct > 25:
                trends["warnings"].append(
                    f"mode {m}: recent avg ${recent_10_avg:.2f} "
                    f"is {drift_pct:.0f}% above baseline"
                )
        else:
            entry["status"] = "insufficient_baseline"
        trends["modes"][m] = entry
        print(
            f"cost-trends: mode {m}: avg=${entry['overall_avg']:.2f} "
            f"recent=${entry['recent_10_avg']:.2f} [{entry['status']}]"
        )

    with open(trend_file, "w") as f:
        json.dump(trends, f, indent=2)
        f.write("\n")
    for w in trends["warnings"]:
        print(f"\u26a0 cost-trends: {w}")


def check_utilization(data, session_num, util_file):
    """Step 4: budget utilization per mode."""
    clean_data = [e for e in data if not e.get("deprecated")]
    if len(clean_data) < 10:
        return

    by_mode_util = defaultdict(list)
    for e in clean_data:
        m = e["mode"]
        cap = CAPS.get(m, 10)
        util = (e["cost"] / cap * 100) if cap > 0 else 0
        by_mode_util[m].append(
            {
                "session": e.get("session", 0),
                "spent": e["cost"],
                "cap": cap,
                "util_pct": round(util, 1),
            }
        )

    report = {
        "generated": datetime.now().isoformat(),
        "session": session_num,
        "modes": {},
        "recommendations": [],
    }
    for m, entries in by_mode_util.items():
        cap = CAPS.get(m, 10)
        utils = [e["util_pct"] for e in entries]
        recent_20 = entries[-20:] if len(entries) >= 20 else entries
        recent_utils = [e["util_pct"] for e in recent_20]
        avg_util = sum(utils) / len(utils)
        recent_avg = sum(recent_utils) / len(recent_utils)
        median_util = sorted(utils)[len(utils) // 2]
        entry = {
            "cap": cap,
            "total_sessions": len(entries),
            "avg_util_pct": round(avg_util, 1),
            "recent_20_avg_pct": round(recent_avg, 1),
            "median_util_pct": round(median_util, 1),
        }
        if recent_avg < 20 and len(recent_20) >= 10:
            entry["status"] = "underutilized"
        elif recent_avg > 80:
            entry["status"] = "tight"
        else:
            entry["status"] = "healthy"
        report["modes"][m] = entry
        print(f"budget-util: mode {m}: avg {avg_util:.0f}% [{entry['status']}]")

    with open(util_file, "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")


def write_budget_nudge(data, mode, session_num, nudge_file):
    """Step 5: R-mode budget nudge for consistently low-spend sessions."""
    if mode != "R":
        return

    r_sessions = [e for e in data if e.get("mode") == "R"]
    if len(r_sessions) < 3:
        return

    recent = r_sessions[-5:]
    budget = 5.0
    low = [e for e in recent if e["cost"] / budget < 0.20]
    if len(low) >= 3:
        avg_spent = sum(e["cost"] for e in recent) / len(recent)
        avg_pct = avg_spent / budget * 100
        with open(nudge_file, "w") as f:
            f.write("## Budget utilization alert (R sessions)\n")
            f.write(
                f"Last {len(recent)} R sessions averaged "
                f"${avg_spent:.2f} of ${budget:.2f} budget "
                f"({avg_pct:.0f}% utilization).\n"
            )
            f.write(
                f"{len(low)}/{len(recent)} sessions used less than "
                f"20% of available budget.\n\n"
            )
            f.write(
                "Low-budget R sessions produce shallow work: "
                "directives get marked complete without verification, "
                "structural changes are not tested, and queue items are "
                "generated from templates instead of real analysis.\n\n"
            )
            f.write(
                f"USE YOUR BUDGET. Before committing any change, verify it works "
                f"by running the modified code. Before marking any directive "
                f"complete, demonstrate the fix with actual command output. "
                f"Read more files, check more state, test more thoroughly. "
                f"You have ${budget:.2f} -- use at least $1.50.\n"
            )
        print(f"budget-nudge: alert written ({len(low)}/{len(recent)} under 20%)")
    else:
        if os.path.exists(nudge_file):
            os.remove(nudge_file)
        print(f"budget-nudge: ok ({len(low)}/{len(recent)} under 20%)")


def track_e_budget_gate(data, mode, session_num, this_cost):
    """Step 6: E-mode budget gate tracking (wq-190)."""
    if mode != "E":
        return

    tracking_file = os.path.expanduser(
        "~/.config/moltbook/e-budget-gate-tracking.json"
    )
    if not os.path.exists(tracking_file):
        return

    try:
        tracking = json.load(open(tracking_file))
        gate_session = tracking.get("gate_session", 895)
        if session_num <= gate_session:
            return

        recorded_sessions = [
            s["session"] for s in tracking.get("post_gate_sessions", [])
        ]
        if session_num in recorded_sessions:
            return

        budget_gate = 2.00
        passed = this_cost >= budget_gate
        tracking.setdefault("post_gate_sessions", []).append(
            {
                "session": session_num,
                "cost": round(this_cost, 4),
                "passed": passed,
                "recorded_at": datetime.now().isoformat(),
            }
        )
        with open(tracking_file, "w") as f:
            json.dump(tracking, f, indent=2)
        status = "PASSED" if passed else "FAILED"
        print(
            f"e-budget-gate: s{session_num} ${this_cost:.2f} {status} "
            f"(gate=${budget_gate:.2f})"
        )

        failures = [
            s
            for s in tracking.get("post_gate_sessions", [])
            if not s.get("passed")
        ]
        threshold = tracking.get("escalation_threshold", 3)
        if len(failures) >= threshold:
            print(
                f"\u26a0 e-budget-gate: ESCALATION NEEDED - "
                f"{len(failures)} failures >= {threshold} threshold"
            )
            tracking["status"] = "escalation_needed"
            with open(tracking_file, "w") as f:
                json.dump(tracking, f, indent=2)
    except Exception as e:
        print(f"e-budget-gate: error - {e}")


def main():
    if len(sys.argv) < 9:
        print(
            "Usage: cost-analysis.py <cost_file> <trend_file> <util_file> "
            "<nudge_file> <directive_file> <mode> <session_num> <spent>",
            file=sys.stderr,
        )
        sys.exit(1)

    cost_file, trend_file, util_file, nudge_file, directive_file = sys.argv[1:6]
    mode = sys.argv[6]
    session_num = int(sys.argv[7])
    this_cost = float(sys.argv[8])

    data = load_cost_data(cost_file)
    if len(data) < 5:
        print(f"cost-pipeline: insufficient data ({len(data)} sessions)")
        sys.exit(0)

    detect_anomaly(data, mode, session_num, this_cost, directive_file)
    analyze_trends(data, session_num, trend_file)
    check_utilization(data, session_num, util_file)
    write_budget_nudge(data, mode, session_num, nudge_file)
    track_e_budget_gate(data, mode, session_num, this_cost)


if __name__ == "__main__":
    main()
