#!/usr/bin/env bash
# Fork-local: daily secretary brief for the career-ops data root.
# Zero tokens, read-only. Composes the existing zero-token reports into
# $DATA_ROOT/briefs/YYYY-MM-DD.md. It never sends mail, never edits the tracker,
# and never runs reply-watch (that mode is interactive).
# Declared in config/local-paths.txt so update-system.mjs leaves it alone.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cat "$HERE/.career-ops-data" 2>/dev/null || echo "$HERE")"
DAY="${1:-$(date +%F)}"
OUT="$ROOT/briefs/$DAY.md"
# systemd runs this with a minimal PATH (node/grep/coreutils only); python3 and sed
# live in the system profile, so add it rather than depend on the unit's env.
export PATH="/run/current-system/sw/bin:/etc/profiles/per-user/${USER}/bin:$PATH"
NODE="${NODE:-node}"

mkdir -p "$ROOT/briefs" || exit 1
cd "$HERE" || exit 1

count_replies() {
  "$NODE" -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const a = Array.isArray(j) ? j : (j.candidates || []);
      console.log(a.length);
    } catch { console.log("unreadable"); }
  ' "$ROOT/data/reply-candidates.json" 2>/dev/null || echo "unreadable"
}

{
  echo "# Secretary brief — $DAY"
  echo
  echo "_Mechanical snapshot, generated $(date '+%F %H:%M %Z') from \`$ROOT\`._"
  echo "_No scores, no judgment — the agent turns this into the short brief._"
  echo

  echo "## 1. Inbox / replies"
  if [ -f "$HOME/.config/msmtp/gmail.apppassword" ]; then
    ( cd "$HERE" && timeout 240 python3 mail-fetch.py --days 3 >/dev/null 2>&1 ) || true
    if [ -f "$ROOT/data/mail-fetch-last.json" ]; then
      python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
print("- Last fetch {}: scanned {}, new {}, job-related {}".format(d["date"], d["scanned"], d["new"], d["matched"]))
for h in d["hits"][:10]:
    print("  - {}: {} — {}".format(h.get("folder", "INBOX"), h["from"][:42], h["subject"][:64]))
' "$ROOT/data/mail-fetch-last.json"
    else
      echo "- Mailbox configured, but no fetch has completed yet."
    fi
    if [ -f "$ROOT/data/reply-candidates.json" ]; then
      echo "- Reply candidates on file: **$(count_replies)** — classify with \`node reply-watch.mjs\`"
      echo "  (interactive; recommends tracker changes, never applies them)."
    fi
    echo "- Fetch reads INBOX, All Mail and Trash: confirmations and rejections get archived or"
    echo "  deleted by the owner's filters within hours, so INBOX alone under-reports."
  else
    echo "- **No mailbox connected.** Nothing is reading your mail yet, so this section is"
    echo "  empty by absence, not by silence. Nothing has been checked."
  fi
  echo

  echo "## 2. Follow-ups"
  "$NODE" followup-cadence.mjs --summary 2>&1 | sed -n '1,30p' || echo "_followup-cadence failed_"
  echo

  echo "## 3. Closing soon"
  "$NODE" closing-soon.mjs --summary 2>&1 | tail -20 || echo "_closing-soon failed_"
  echo

  echo "## 4. Agent inbox (tasks queued for me)"
  "$NODE" agent-inbox.mjs list --all 2>&1 | head -20 || echo "_agent-inbox failed_"
  echo

  echo "## 5. Counters"
  "$NODE" stats.mjs --summary 2>&1 | sed -n '3,12p' || echo "_stats failed_"
  echo
  echo "- Pipeline pending rows: **$(grep -c '^- \[ \]' "$ROOT/data/pipeline.md" 2>/dev/null || echo '?')**"
  LAST_REPORT="$(ls "$ROOT/reports" 2>/dev/null | grep -E '^[0-9]{3}-' | sort | tail -1)"
  echo "- Newest report: **${LAST_REPORT:-none}**"
  echo "- Outbox waiting for an explicit send: **$(ls "$ROOT/outbox"/*.eml 2>/dev/null | wc -l | tr -d ' ')**"
  echo

  echo "## 6. What the agent owes you in the read-out"
  echo
  echo "1. Replies that need an answer today, one line each, with the ask."
  echo "2. Follow-ups overdue and which ones are worth sending."
  echo "3. Anything closing this week."
  echo "4. One decision per item you cannot take yourself (send, price, schedule)."
  echo "5. Never restate the numbers above without saying what changed since the last brief."
} > "$OUT" 2>&1

printf '%s\n' "$OUT"
