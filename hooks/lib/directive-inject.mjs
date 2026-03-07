#!/usr/bin/env node
// directive-inject.mjs — Extract pending directives and answered questions
// Originally extracted from 41-directive-inject.sh inline node -e block (d075, R#339)

import { readFileSync } from 'fs';

const directivesPath = process.argv[2];
if (!directivesPath) {
  process.stderr.write('Usage: directive-inject.mjs <directives.json path>\n');
  process.exit(1);
}

let d;
try {
  d = JSON.parse(readFileSync(directivesPath, 'utf8'));
} catch {
  process.exit(1);
}

const pending = (d.directives || []).filter(x => x.status === 'pending' || !x.acked_session);
const answered = (d.questions || []).filter(q => q.answered && q.status !== 'resolved');
const lines = [];

if (pending.length) {
  lines.push('## PENDING DIRECTIVES (from directives.json)');
  for (const p of pending) lines.push(`- ${p.id} [s${p.session}]: ${p.content}`);
  lines.push('Run `node directives.mjs ack <id> <session>` after reading each one.');
}
if (answered.length) {
  lines.push('');
  lines.push('## ANSWERED QUESTIONS (human responded)');
  for (const q of answered) lines.push(`- ${q.id} re:${q.directive_id}: Q: ${q.text} → A: ${q.answer}`);
}

if (lines.length) {
  process.stdout.write(lines.join('\n') + '\n');
} else {
  process.exit(1); // no output needed
}
