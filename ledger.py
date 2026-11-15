#!/usr/bin/env python3
"""Fork-local ledger for the job search: one append-only event log, no exceptions.

State lives where it always did (tracker = application state, outbox = drafts,
reports = evaluations). This file records *events* — what happened, when, and
what it obliges next — so nothing depends on an agent remembering.

Usage:
  python3 ledger.py add --kind applied --subject "n8n — Staff Platform Engineer" \
      --ref "#29" --state evaluated --next "Owner: Berlin relocation yes/no" --due 2026-11-18
  python3 ledger.py list [--open] [--kind email_in] [--since 2026-11-01]
  python3 ledger.py check [--summary]      # gaps + overdue, exit 1 if any
  python3 ledger.py backfill [--dry-run]   # seed from tracker, sent.log, triage

Kinds: applied, email_in, email_out, decision, task, contact, interview, offer,
rejection, lead, note.
"""

import argparse
import csv
import pathlib
import re
import sys
from datetime import date, datetime

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path((HERE / ".career-ops-data").read_text().strip()) if (HERE / ".career-ops-data").exists() else HERE
LEDGER = ROOT / "data/activity-log.tsv"
COLS = ["ts", "kind", "subject", "detail", "ref", "state", "next_action", "due", "source"]

KINDS = {"applied", "email_in", "email_out", "decision", "task", "contact",
         "interview", "offer", "rejection", "lead", "note"}
OPEN_STATES = {"open", "waiting", "pending"}


def read_rows():
    if not LEDGER.exists():
        return []
    with LEDGER.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def write_row(row):
    new = not LEDGER.exists()
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, delimiter="\t", lineterminator="\n")
        if new:
            w.writeheader()
        w.writerow({c: row.get(c, "") for c in COLS})


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def exists(rows, kind, subject, ref=""):
    return any(r["kind"] == kind and norm(r["subject"]) == norm(subject)
               and (not ref or r["ref"] == ref) for r in rows)


def cmd_add(a):
    if a.kind not in KINDS:
        print(f"unknown kind {a.kind!r}; one of {sorted(KINDS)}", file=sys.stderr)
        return 2
    rows = read_rows()
    if exists(rows, a.kind, a.subject, a.ref or ""):
        print(f"duplicate, not added: {a.kind} / {a.subject}")
        return 0
    write_row({
        "ts": a.on or date.today().isoformat(),
        "kind": a.kind, "subject": a.subject, "detail": a.detail or "",
        "ref": a.ref or "", "state": a.state or "open",
        "next_action": a.next or "", "due": a.due or "", "source": a.source or "agent",
    })
    print(f"logged: {a.kind} / {a.subject}")
    return 0


def cmd_list(a):
    rows = read_rows()
    if a.kind:
        rows = [r for r in rows if r["kind"] == a.kind]
    if a.open:
        rows = [r for r in rows if r["state"] in OPEN_STATES or r["next_action"]]
    if a.since:
        rows = [r for r in rows if r["ts"] >= a.since]
    for r in rows:
        due = f" · due {r['due']}" if r["due"] else ""
        nxt = f" → {r['next_action']}" if r["next_action"] else ""
        print(f"{r['ts']}  {r['kind']:<10} {r['subject']}{due}{nxt}")
    print(f"\n{len(rows)} row(s)")
    return 0


def tracker_rows():
    path = ROOT / "data/applications.md"
    out = []
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("|") or line.startswith("|---") or line.startswith("| #"):
            continue
        c = [x.strip() for x in line.strip("|").split("|")]
        if len(c) < 7 or not c[0].isdigit():
            continue
        out.append({"num": c[0], "date": c[1], "company": c[2], "role": c[3], "status": c[6]})
    return out


def cmd_check(a):
    rows = read_rows()
    today = date.today().isoformat()
    problems = []

    # 1. overdue obligations
    for r in rows:
        if r["due"] and r["due"] < today and (r["state"] in OPEN_STATES or r["state"] == ""):
            problems.append(f"OVERDUE {r['due']} — {r['kind']}: {r['subject']} → {r['next_action']}")

    # 2. applications with no obligation recorded
    for t in tracker_rows():
        if t["status"] not in ("Applied",):
            continue
        ref = f"#{t['num']}"
        has = any(r["ref"] == ref and r["kind"] in ("applied", "email_in", "interview", "task") for r in rows)
        if not has:
            problems.append(f"UNTRACKED application {ref} {t['company']} — no ledger row")

    # 3. reply candidates not in the ledger
    rc = ROOT / "data/reply-candidates.json"
    if rc.exists():
        import json
        try:
            data = json.loads(rc.read_text())
            cands = data if isinstance(data, list) else data.get("candidates", [])
        except Exception:
            cands = []
        logged = {norm(r["subject"]) for r in rows if r["kind"] in ("email_in", "rejection")}
        for c in cands:
            if norm(c.get("subject", "")) not in logged:
                problems.append(f"UNTRACKED email — {c.get('subject','')[:70]}")

    # 4. open tasks older than 7 days
    for r in rows:
        if r["kind"] == "task" and r["state"] in OPEN_STATES:
            age = (date.fromisoformat(today) - date.fromisoformat(r["ts"])).days
            if age > 7:
                problems.append(f"STALE task ({age}d) — {r['subject']}")

    if a.summary:
        if problems:
            print(f"{len(problems)} gap(s):")
            for p in problems[:20]:
                print(" - " + p)
        else:
            print("ledger clean: no gaps, nothing overdue")
    else:
        for p in problems:
            print(p)
    return 1 if problems else 0


def cmd_backfill(a):
    rows = read_rows()
    added = 0
    for t in tracker_rows():
        subj = f"{t['company']} — {t['role']}"
        kind = "applied" if t["status"] == "Applied" else "decision"
        if exists(rows, kind, subj, f"#{t['num']}"):
            continue
        row = {"ts": t["date"], "kind": kind, "subject": subj, "ref": f"#{t['num']}",
               "state": t["status"].lower(), "source": "backfill"}
        if not a.dry_run:
            write_row(row)
        rows.append(row)
        added += 1
    sent = ROOT / "outbox/sent.log"
    if sent.exists():
        for line in sent.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            subj = f"to {parts[2]}: {parts[3]}"
            if exists(rows, "email_out", subj):
                continue
            row = {"ts": parts[0][:10], "kind": "email_out", "subject": subj,
                   "ref": parts[1], "state": "sent", "source": "backfill"}
            if not a.dry_run:
                write_row(row)
            rows.append(row)
            added += 1
    print(f"backfill: {added} row(s) {'(dry-run)' if a.dry_run else 'added'}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add"); a.set_defaults(fn=cmd_add)
    a.add_argument("--kind", required=True)
    a.add_argument("--subject", required=True)
    a.add_argument("--detail", default="")
    a.add_argument("--ref", default="")
    a.add_argument("--state", default="open")
    a.add_argument("--next", default="")
    a.add_argument("--due", default="")
    a.add_argument("--on", default="")
    a.add_argument("--source", default="agent")

    l = sub.add_parser("list"); l.set_defaults(fn=cmd_list)
    l.add_argument("--kind"); l.add_argument("--open", action="store_true"); l.add_argument("--since")

    c = sub.add_parser("check"); c.set_defaults(fn=cmd_check)
    c.add_argument("--summary", action="store_true")

    b = sub.add_parser("backfill"); b.set_defaults(fn=cmd_backfill)
    b.add_argument("--dry-run", action="store_true")

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
