#!/usr/bin/env python3
"""
Objective protocol-chain auditor for unknowing-agent E2E runs.

Parses the codex-skills-mcp activity log, takes only events AFTER a baseline
line count, and verdicts whether the agent followed the 5-step protocol
(DISCOVER -> MATERIALIZE -> EXECUTE -> VERIFY) for a given skill.

Usage:
  python3 test/audit_protocol.py <activity.jsonl> <baseline_lines> <skill_name> [--gap-seconds N]

Exit 0 = PASS, 1 = FAIL. Designed for the integration workflow described in
codexproject .agents/skills/codex-skills-development-rules/references/06_e2e_verification.md.
"""
import argparse
import json
import sys
from datetime import datetime


def parse_ts(ts):
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log_file")
    ap.add_argument("baseline", type=int)
    ap.add_argument("skill")
    ap.add_argument("--gap-seconds", type=int, default=60,
                    help="Min local-execution gap (materialize->verify) to count as real work")
    args = ap.parse_args()

    events = []
    with open(args.log_file, encoding="utf-8") as fh:
        for i, line in enumerate(fh, 1):
            if i <= args.baseline:
                continue
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not events:
        print("FAIL: no events after baseline")
        return 1

    calls = [e for e in events if e.get("event") == "tool_call"]
    downloads = [e for e in events if e.get("event", "").startswith("download_skill")]

    # chronological chain of relevant entries
    chain = []
    for e in events:
        ev = e.get("event", "")
        if ev == "tool_call":
            chain.append((e["ts"], "call:" + e.get("tool", "?"), e.get("detail", "")))
        elif ev.startswith("download_skill"):
            chain.append((e["ts"], ev, e.get("skill", "")))

    print("== chain after baseline ==")
    for ts, ev, detail in chain:
        print(f"  {ts[11:19]}  {ev:<28} {str(detail)[:64]}")

    checks = []

    def check(name, ok):
        checks.append((name, ok))
        print(("  ✅ " if ok else "  ❌ ") + name)

    print("== verdicts ==")
    discover = [c for c in calls if c.get("tool") in ("search_skills", "plan_workflow")]
    reads = [c for c in calls if c.get("tool") == "read_skill"]
    read_skill = [c for c in reads if args.skill.lower() in str(c.get("detail", "")).lower()]
    statuses = [c for c in calls if c.get("tool") == "skill_status"
                and args.skill.lower() in str(c.get("detail", "")).lower()]
    dl = [d for d in downloads if d.get("skill", "").lower() == args.skill.lower()]

    check("DISCOVER: >=1 search_skills/plan_workflow call", len(discover) >= 1)
    check(f"MATERIALIZE: read_skill({args.skill}) called", len(read_skill) >= 1)

    if discover and read_skill:
        d_ts = min(parse_ts(c["ts"]) for c in discover)
        r_ts = min(parse_ts(c["ts"]) for c in read_skill)
        check("ORDER: discover precedes materialize", d_ts <= r_ts)

    check("COLD-DOWNLOAD: download events for skill (cold-cache runs)", len(dl) >= 1)

    # EXECUTE gap, PAIR-BASED: the log may interleave several sessions
    # (agent runs + manual refreshes), so measure each verify step against
    # its nearest preceding materialization call and pass on ANY qualifying
    # pair — a single whole-delta measurement gets polluted by other sessions.
    mat_calls = [c for c in calls if c.get("tool") in ("read_skill", "load_skill_file")]
    verify_targets = statuses or [c for c in calls if parse_ts(c["ts"]) > min(m["ts"] for m in mat_calls)] if mat_calls else []
    gaps = []
    for v in verify_targets:
        v_ts = parse_ts(v["ts"])
        prior = [m for m in mat_calls if parse_ts(m["ts"]) <= v_ts]
        if prior:
            gaps.append((v_ts - max(parse_ts(m["ts"]) for m in prior)).total_seconds())
    if gaps:
        best = max(gaps)
        check(f"EXECUTE: local-execution gap >= {args.gap_seconds}s (best pair {best:.0f}s)", best >= args.gap_seconds)
    else:
        print("  ⚠️ EXECUTE: no materialize->verify pair to measure gap")

    check("VERIFY: skill_status called for skill", len(statuses) >= 1)

    hard = [ok for name, ok in checks if not name.startswith("COLD-DOWNLOAD") and not name.startswith("VERIFY")]
    cold_required = "--cold" in sys.argv
    passed = all(ok for name, ok in checks if not (name.startswith("COLD-DOWNLOAD") and not cold_required))
    print("== RESULT:", "PASS" if passed else "FAIL", "==")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
