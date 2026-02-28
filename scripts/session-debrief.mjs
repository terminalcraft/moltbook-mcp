#!/usr/bin/env node
/**
 * Extract decisions, blockers, and completed tasks from a session log (JSONL).
 * Usage: session-debrief.mjs <log_file> <session_num> <mode> [focus]
 * Appends structured debrief to ~/.config/moltbook/session-debriefs.json
 *
 * Migrated from session-debrief.py (wq-728, B#485)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const debriefFile = join(homedir(), '.config/moltbook/session-debriefs.json');

function extractTexts(logPath) {
  const texts = [];
  const content = readFileSync(logPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const role = obj.role || '';
    const c = obj.content;

    if (role === 'assistant') {
      if (typeof c === 'string') {
        texts.push(c.slice(0, 2000));
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block && block.type === 'text' && block.text) {
            texts.push(block.text.slice(0, 2000));
          }
        }
      }
    } else if (role === 'tool' && typeof c === 'string') {
      const low = c.toLowerCase();
      if (['error', 'blocked', 'failed', 'denied', 'timeout'].some(w => low.includes(w))) {
        texts.push(`[TOOL_ERR] ${c.slice(0, 500)}`);
      }
    }
  }
  return texts;
}

function analyze(texts) {
  const decisions = [];
  const blockers = [];
  const tasksDone = [];

  const decisionPats = [
    /(?:decided|choosing|going with|will use|switching to|picked) .{10,80}/gi,
    /(?:the approach|solution|plan) (?:is|will be) .{10,80}/gi,
  ];
  const blockerPats = [
    /(?:blocked|cannot|unable to|failed because|broken) .{10,80}/gi,
    /(?:waiting on|depends on|need.{0,10}before) .{10,80}/gi,
  ];
  const taskPats = [
    /(?:completed|shipped|done|committed).{0,80}/gi,
  ];

  for (const t of texts) {
    for (const pat of decisionPats) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(t)) !== null) {
        decisions.push(m[0].slice(0, 120));
      }
    }
    for (const pat of blockerPats) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(t)) !== null) {
        blockers.push(m[0].slice(0, 120));
      }
    }
    for (const pat of taskPats) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(t)) !== null) {
        tasksDone.push(m[0].slice(0, 120));
      }
    }
  }

  // Dedup preserving order
  const dedup = arr => [...new Set(arr)].slice(0, 10);
  return {
    decisions: dedup(decisions),
    blockers: dedup(blockers),
    tasks_completed: dedup(tasksDone),
  };
}

const logFilePath = process.argv[2];
const sessionNum = parseInt(process.argv[3], 10);
const mode = process.argv[4] || '?';
const focus = process.argv[5] || null;

if (!logFilePath || !sessionNum) {
  console.error('Usage: session-debrief.mjs <log_file> <session_num> <mode> [focus]');
  process.exit(1);
}

if (!existsSync(logFilePath)) {
  console.error(`Log file not found: ${logFilePath}`);
  process.exit(1);
}

const texts = extractTexts(logFilePath);
const result = analyze(texts);

const entry = {
  timestamp: new Date().toISOString(),
  session: sessionNum,
  mode,
  focus,
  ...result,
};

mkdirSync(dirname(debriefFile), { recursive: true });
let data = [];
if (existsSync(debriefFile)) {
  try { data = JSON.parse(readFileSync(debriefFile, 'utf8')); } catch { data = []; }
}
data.push(entry);
if (data.length > 100) data = data.slice(-100);
writeFileSync(debriefFile, JSON.stringify(data, null, 2));

console.log(`Debrief s${sessionNum}: ${result.decisions.length} decisions, ${result.blockers.length} blockers, ${result.tasks_completed.length} tasks`);
