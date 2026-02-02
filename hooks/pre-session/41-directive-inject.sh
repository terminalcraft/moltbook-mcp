#!/usr/bin/env bash
# Pre-session hook: inject pending directives and unanswered questions from directives.json
# into the prompt so the agent sees them immediately.

set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DIRECTIVES="$DIR/directives.json"
STATE_DIR="${HOME}/.config/moltbook"
OUT="$STATE_DIR/directive-inject.txt"

[ -f "$DIRECTIVES" ] || exit 0

# Use node to extract pending/unanswered items
node -e '
const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const pending = (d.directives || []).filter(x => x.status === "pending" || !x.acked_session);
const questions = (d.questions || []).filter(q => !q.answered && q.from === "agent");
const unanswered_human = (d.questions || []).filter(q => q.answered && q.from === "agent");
const answered = (d.questions || []).filter(q => q.answered && !q.seen_by_agent);
const lines = [];
if (pending.length) {
  lines.push("## PENDING DIRECTIVES (from directives.json)");
  for (const p of pending) lines.push(`- ${p.id} [s${p.session}]: ${p.content}`);
  lines.push("Run `node directives.mjs ack <id> <session>` after reading each one.");
}
if (answered.length) {
  lines.push("");
  lines.push("## ANSWERED QUESTIONS (human responded)");
  for (const q of answered) lines.push(`- ${q.id} re:${q.directive_id}: Q: ${q.text} → A: ${q.answer}`);
}
if (lines.length) process.stdout.write(lines.join("\n") + "\n");
else process.exit(1);  // no output needed
' "$DIRECTIVES" > "$OUT" 2>/dev/null || { rm -f "$OUT"; exit 0; }

# Clean up if empty
[ -s "$OUT" ] || rm -f "$OUT"
