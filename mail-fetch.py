#!/usr/bin/env python3
"""Fork-local Gmail reader for career-ops: INBOX -> reply candidates.

Zero tokens, stdlib only (imaplib). Reads the last N days of INBOX over IMAP,
keeps only messages that look like an application reply (ATS domain, a company
already in the tracker, or recruiting language), and feeds each one to
paste-reply.mjs so reply-watch.mjs can classify it in a session.

It never classifies, never updates the tracker, never sends, and never deletes
or marks mail read (BODY.PEEK). Message-IDs are recorded in data/mail-seen.tsv
so a re-run is cheap.

Usage:
  python3 mail-fetch.py --days 30 --dry-run
  python3 mail-fetch.py --days 30
"""

import argparse
import base64
import email
import email.policy
import imaplib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
from datetime import date, timedelta

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path((HERE / ".career-ops-data").read_text().strip()) if (HERE / ".career-ops-data").exists() else HERE
CREDS = pathlib.Path.home() / ".config/msmtp/gmail.apppassword"
USER = "khasanjonovich@gmail.com"
SEEN = ROOT / "data/mail-seen.tsv"
SUMMARY = ROOT / "data/mail-fetch-last.json"

ATS_DOMAINS = (
    "greenhouse.io", "ashbyhq.com", "lever.co", "workday.com", "myworkdayjobs.com",
    "smartrecruiters.com", "teamtailor.com", "workable.com", "personio.de",
    "recruitee.com", "icims.com", "successfactors.com", "jobvite.com", "breezy.hr",
    "rippling.com", "wellfound.com", "hired.com", "gem.com", "eightfold.ai",
    "paradox.ai", "hire.withgoogle.com", "jobs.lever.co", "applytojob.com",
)
RECRUIT_WORDS = (
    "your application", "your candidacy", "thank you for applying",
    "thanks for applying", "thank you for your interest", "interview",
    "next step", "we regret", "not moving forward", "unfortunately",
    "phone screen", "take-home", "technical task",
)
# Senders that look like job mail but are newsletters or marketing.
NOISE_SENDERS = ("ui.dev", "leetcode.com", "substack.com", "medium.com",
                 "instagram.com", "github.com", "linkedin.com", "melOn".lower())


def tracker_companies() -> list[str]:
    path = ROOT / "data/applications.md"
    names: set[str] = set()
    if not path.exists():
        return []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("|") or line.startswith("|---") or line.startswith("| #"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 3 or not cells[0].isdigit():
            continue
        raw = cells[2]
        for part in re.split(r"[()]", raw):
            for chunk in re.split(r"\bvia\b", part):
                token = chunk.strip().removesuffix(".ai").strip(" -–—")
                if len(token) >= 4 and token.lower() not in {"insurance", "client", "new"}:
                    names.add(token.lower())
    return sorted(names)


def body_text(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition") or ""):
                try:
                    return part.get_content()
                except Exception:
                    continue
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                try:
                    html = part.get_content()
                    return re.sub(r"<[^>]+>", " ", html)
                except Exception:
                    continue
        return ""
    try:
        return msg.get_content()
    except Exception:
        payload = msg.get_payload(decode=True) or b""
        return payload.decode("utf-8", "replace")


def looks_like_reply(sender: str, subject: str, body: str, companies: list[str]) -> str | None:
    low_sender = sender.lower()
    if any(n in low_sender for n in NOISE_SENDERS):
        return None
    hay = f"{sender}\n{subject}\n{body[:4000]}".lower()
    for d in ATS_DOMAINS:
        if d in sender.lower():
            return f"ats:{d}"
    for c in companies:
        if c and c in hay:
            return f"company:{c}"
    for w in RECRUIT_WORDS:
        if w in subject.lower():
            return f"keyword:{w}"
    for w in ("your application", "your candidacy", "thank you for applying", "we regret"):
        if w in body[:3000].lower():
            return f"body:{w}"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()

    if not CREDS.exists():
        print(json.dumps({"error": "no app password at ~/.config/msmtp/gmail.apppassword"}))
        return 2
    pw = "".join(CREDS.read_text().split())

    seen: set[str] = set()
    if SEEN.exists():
        seen = {line.split("\t")[0] for line in SEEN.read_text().splitlines() if line}

    companies = tracker_companies()
    since = (date.today() - timedelta(days=args.days)).strftime("%d-%b-%Y")

    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(USER, pw)

    scanned = new = matched = 0
    hits = []
    ids_seen_this_run: set[str] = set()

    # Confirmation and rejection mail gets archived or trashed by the owner's
    # filters as fast as it arrives, so INBOX alone misses it. Read all three.
    for folder in ("INBOX", "[Gmail]/All Mail", "[Gmail]/Trash"):
        typ, _ = M.select(f'"{folder}"', readonly=True)
        if typ != "OK":
            continue
        typ, data = M.search(None, f"(SINCE {since})")
        ids = data[0].split()[-args.limit:]

        for num in ids:
            typ, raw = M.fetch(num, "(BODY.PEEK[])")
            if typ != "OK" or not raw or not isinstance(raw[0], tuple):
                continue
            msg = email.message_from_bytes(raw[0][1], policy=email.policy.default)
            scanned += 1
            mid = (msg.get("Message-ID") or "").strip() or f"no-id-{folder}-{num.decode()}"
            if mid in seen or mid in ids_seen_this_run:
                continue
            ids_seen_this_run.add(mid)
            new += 1
            sender = str(msg.get("From") or "")
            subject = str(msg.get("Subject") or "(no subject)")
            if USER in sender.lower():
                if not args.dry_run:
                    with SEEN.open("a") as fh:
                        fh.write(f"{mid}\t{date.today()}\t{subject[:80]}\tself\n")
                continue
            body = body_text(msg)
            reason = looks_like_reply(sender, subject, body, companies)
            if reason:
                matched += 1
                hits.append({"folder": folder, "from": sender, "subject": subject, "reason": reason})
                if not args.dry_run:
                    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
                        fh.write(f"Subject: {subject}\nFrom: {sender}\n\n{body[:8000]}\n")
                        tmp = fh.name
                    r = subprocess.run(["node", "paste-reply.mjs", "--file", tmp], cwd=HERE,
                                       capture_output=True, text=True)
                    hits[-1]["paste"] = (r.stdout or r.stderr).strip().splitlines()[-1:] or [""]
                    pathlib.Path(tmp).unlink(missing_ok=True)
                    with SEEN.open("a") as fh:
                        fh.write(f"{mid}\t{date.today()}\t{subject[:80]}\t{reason}\n")
            elif not args.dry_run:
                with SEEN.open("a") as fh:
                    fh.write(f"{mid}\t{date.today()}\t{subject[:80]}\tskipped\n")

    M.logout()
    summary = {"date": str(date.today()), "since": since, "scanned": scanned,
               "new": new, "matched": matched, "hits": hits, "dry_run": args.dry_run}
    if not args.dry_run:
        SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
