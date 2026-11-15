#!/usr/bin/env python3
"""Fork-local signal log: what people implied, not what they said.

The owner does not read hints reliably — it is in his profile, and it costs him
interviews. So every inbound email, call and posting gets its signals written
down explicitly: the quote, what it probably means, how sure that is, and the
one question that would confirm or kill it.

A signal is never treated as fact. It stays open until the question is asked.

Usage:
  python3 signals.py add --source email --who "Fieldguide Hiring Team" \
      --said "Thank you for your interest in Fieldguide" \
      --implied "Rejection before the body says so; 'interest' not 'application'" \
      --confidence medium --verify "none needed, body confirmed it" --ref "#7"
  python3 signals.py list [--open] [--source interview]
  python3 signals.py resolve <n> --status confirmed|refuted --note "..."

Columns: ts, source, who, said, implied, confidence, verify, status, ref, note
"""

import argparse
import csv
import pathlib
import sys
from datetime import date

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path((HERE / ".career-ops-data").read_text().strip()) if (HERE / ".career-ops-data").exists() else HERE
PATH = ROOT / "data/signals.tsv"
COLS = ["ts", "source", "who", "said", "implied", "confidence", "verify", "status", "ref", "note"]
SOURCES = {"email", "call", "interview", "posting", "chat", "in-person"}
CONF = {"low", "medium", "high"}


def rows():
    if not PATH.exists():
        return []
    with PATH.open(encoding="utf-8") as fh:
        return list(csv.DictReader(fh, delimiter="\t"))


def write(row):
    new = not PATH.exists()
    PATH.parent.mkdir(parents=True, exist_ok=True)
    with PATH.open("a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, delimiter="\t", lineterminator="\n")
        if new:
            w.writeheader()
        w.writerow({c: row.get(c, "") for c in COLS})


def cmd_add(a):
    if a.confidence not in CONF:
        print(f"--confidence must be one of {sorted(CONF)}", file=sys.stderr)
        return 2
    if a.source not in SOURCES:
        print(f"--source must be one of {sorted(SOURCES)}", file=sys.stderr)
        return 2
    write({"ts": a.on or date.today().isoformat(), "source": a.source, "who": a.who,
           "said": a.said, "implied": a.implied, "confidence": a.confidence,
           "verify": a.verify or "", "status": "open", "ref": a.ref or "", "note": ""})
    print(f"signal logged: {a.who} — {a.implied[:70]}")
    return 0


def cmd_list(a):
    data = rows()
    if a.open:
        data = [r for r in data if r["status"] == "open"]
    if a.source:
        data = [r for r in data if r["source"] == a.source]
    for i, r in enumerate(data, 1):
        print(f"{i:>2}. [{r['status']}/{r['confidence']}] {r['ts']} {r['source']} · {r['who']}")
        print(f"    said:    {r['said'][:110]}")
        print(f"    implies: {r['implied'][:110]}")
        if r["verify"]:
            print(f"    verify:  {r['verify'][:110]}")
    print(f"\n{len(data)} signal(s), {sum(1 for r in data if r['status']=='open')} open")
    return 0


def cmd_resolve(a):
    data = rows()
    idx = a.n - 1
    if idx < 0 or idx >= len(data):
        print("no such signal", file=sys.stderr)
        return 2
    data[idx]["status"] = a.status
    if a.note:
        data[idx]["note"] = a.note
    with PATH.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS, delimiter="\t", lineterminator="\n")
        w.writeheader()
        for r in data:
            w.writerow({c: r.get(c, "") for c in COLS})
    print(f"signal {a.n} → {a.status}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add"); a.set_defaults(fn=cmd_add)
    for f in ("--source", "--who", "--said", "--implied"):
        a.add_argument(f, required=True)
    a.add_argument("--confidence", default="medium")
    a.add_argument("--verify", default="")
    a.add_argument("--ref", default="")
    a.add_argument("--on", default="")

    l = sub.add_parser("list"); l.set_defaults(fn=cmd_list)
    l.add_argument("--open", action="store_true"); l.add_argument("--source")

    r = sub.add_parser("resolve"); r.set_defaults(fn=cmd_resolve)
    r.add_argument("n", type=int)
    r.add_argument("--status", required=True, choices=["confirmed", "refuted", "stale"])
    r.add_argument("--note", default="")

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
