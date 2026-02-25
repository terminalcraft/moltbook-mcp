#!/usr/bin/env node
// post-quality-review.mjs — Post quality gate for E sessions (d066)
//
// Modes:
//   --check "<text>"         Pre-post quality check. Exits 0 (pass) or 1 (fail).
//   --audit <session_num>    Post-session audit (reads quality log for session).
//   --history                Show recent quality scores for trend analysis.
//
// Quality signals checked:
//   1. Formulaic openers (detects recycled rhetorical patterns)
//   2. Credential stuffing (self-referential claims like "I build...", "as an agent...")
//   3. Substance ratio (filler vs actual content)
//   4. Repetition (n-gram overlap with recent posts)
//   5. Length appropriateness (too short = empty, too long = rambling)
//
// Created: B#435 (wq-610, d066)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME || '/home/moltbot';
const LOG_DIR = join(HOME, '.config/moltbook/logs');
const QUALITY_LOG = join(LOG_DIR, 'quality-violations.log');
const HISTORY_FILE = join(LOG_DIR, 'quality-scores.jsonl');

// --- Pattern databases ---

const FORMULAIC_OPENERS = [
  /^(this|that|what) (\w+ )?(is|resonates|captures|strikes|nails|highlights)/i,
  /^(really|truly|deeply) (interesting|fascinating|compelling|thought-provoking)/i,
  /^great (point|take|insight|observation|question)/i,
  /^i('ve| have) been (thinking|reflecting|working|building)/i,
  /^as (an agent|someone who|a builder)/i,
  /^the (key|real|interesting|important) (thing|insight|question|point) (here |is)/i,
  /^(love|appreciate) (this|the|your) (take|framing|perspective|approach)/i,
  /^(couldn't|can't) agree more/i,
  /^(exactly|precisely|absolutely)[.!,]?\s/i,
];

const CREDENTIAL_PATTERNS = [
  /i (build|run|maintain|operate|ship) (\w+ )?(\d+ )?(tools|services|platforms|endpoints|systems)/i,
  /my (MCP|api|server|infrastructure|platform|knowledge base)/i,
  /in my experience (building|running|operating|maintaining)/i,
  /\d+ (live|active|running) (services|platforms|capabilities|tools|endpoints)/i,
  /i('ve| have) (built|shipped|deployed|implemented) (this|that|something similar)/i,
  /(from|based on) my (\d+ )?sessions? (of )?(experience|building|learning)/i,
];

const FILLER_PHRASES = [
  /at the end of the day/i,
  /it('s| is) worth (noting|mentioning|considering)/i,
  /in (other words|a sense|many ways)/i,
  /to be (fair|honest|clear)/i,
  /the (fact|reality|truth) (is|of the matter)/i,
  /when you (think|really think|stop to think) about it/i,
  /i think (this|that|what|the)/i,
  /fundamentally/i,
  /essentially/i,
  /at its core/i,
  /the bottom line/i,
];

// --- Scoring functions ---

function checkFormulaicOpeners(text) {
  const firstSentence = text.split(/[.!?\n]/)[0] || '';
  const matches = FORMULAIC_OPENERS.filter(p => p.test(firstSentence.trim()));
  return {
    signal: 'formulaic_opener',
    score: matches.length > 0 ? 0.3 : 1.0,
    detail: matches.length > 0
      ? `Opener matches formulaic pattern: "${firstSentence.trim().slice(0, 60)}..."`
      : null
  };
}

function checkCredentialStuffing(text) {
  const matches = CREDENTIAL_PATTERNS.filter(p => p.test(text));
  // 0 matches = 1.0, 1 match = 0.7, 2+ = 0.3
  const score = matches.length === 0 ? 1.0 : matches.length === 1 ? 0.7 : 0.3;
  return {
    signal: 'credential_stuffing',
    score,
    detail: matches.length > 0
      ? `${matches.length} credential claim(s) detected`
      : null
  };
}

function checkSubstanceRatio(text) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return { signal: 'substance', score: 0, detail: 'Empty text' };

  const fillerCount = FILLER_PHRASES.filter(p => p.test(text)).length;
  const fillerRatio = fillerCount / Math.max(1, words.length / 10); // filler per 10 words
  // Low filler ratio = good substance
  const score = fillerRatio > 2 ? 0.3 : fillerRatio > 1 ? 0.6 : fillerRatio > 0.5 ? 0.8 : 1.0;
  return {
    signal: 'substance',
    score,
    detail: fillerCount > 0 ? `${fillerCount} filler phrase(s)` : null
  };
}

function checkLength(text) {
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  let score = 1.0;
  let detail = null;

  if (words < 5) {
    score = 0.0;
    detail = `Empty engagement (${words} words) — auto-fail`;
  } else if (words < 15) {
    score = 0.2;
    detail = `Too short (${words} words) — likely empty engagement`;
  } else if (words > 300) {
    score = 0.5;
    detail = `Very long (${words} words) — may be rambling`;
  } else if (words > 200) {
    score = 0.7;
    detail = `Long (${words} words) — consider trimming`;
  }
  return { signal: 'length', score, detail };
}

function extractNgrams(text, n = 3) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const ngrams = new Set();
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.add(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

function checkRepetition(text) {
  // Load recent quality scores to find past texts
  if (!existsSync(HISTORY_FILE)) {
    return { signal: 'repetition', score: 1.0, detail: null };
  }

  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const recentTexts = [];
  // Look at last 20 entries
  for (const line of lines.slice(-20)) {
    try {
      const entry = JSON.parse(line);
      if (entry.text) recentTexts.push(entry.text);
    } catch { /* skip bad lines */ }
  }

  if (recentTexts.length === 0) {
    return { signal: 'repetition', score: 1.0, detail: null };
  }

  const currentNgrams = extractNgrams(text);
  if (currentNgrams.size === 0) {
    return { signal: 'repetition', score: 1.0, detail: null };
  }

  // Find max overlap with any recent post
  let maxOverlap = 0;
  for (const past of recentTexts) {
    const pastNgrams = extractNgrams(past);
    let overlap = 0;
    for (const ng of currentNgrams) {
      if (pastNgrams.has(ng)) overlap++;
    }
    const ratio = overlap / currentNgrams.size;
    if (ratio > maxOverlap) maxOverlap = ratio;
  }

  // >40% overlap is concerning, >60% is bad
  const score = maxOverlap > 0.6 ? 0.2 : maxOverlap > 0.4 ? 0.5 : maxOverlap > 0.25 ? 0.8 : 1.0;
  return {
    signal: 'repetition',
    score,
    detail: maxOverlap > 0.25
      ? `${(maxOverlap * 100).toFixed(0)}% n-gram overlap with a recent post`
      : null
  };
}

// --- Main review function ---

function reviewPost(text) {
  const checks = [
    checkFormulaicOpeners(text),
    checkCredentialStuffing(text),
    checkSubstanceRatio(text),
    checkLength(text),
    checkRepetition(text),
  ];

  // Weighted composite score
  const weights = {
    formulaic_opener: 0.2,
    credential_stuffing: 0.25,
    substance: 0.2,
    length: 0.15,
    repetition: 0.2,
  };

  let composite = 0;
  for (const check of checks) {
    composite += check.score * (weights[check.signal] || 0.2);
  }

  const violations = checks.filter(c => c.detail !== null);

  // Hard fail rules — any single catastrophic signal blocks the post
  const hardFails = checks.filter(c => c.score <= 0.2);
  // Multi-signal penalty — 3+ violations means the post is mediocre overall
  const multiViolation = violations.length >= 3;

  let verdict;
  if (hardFails.length > 0) {
    verdict = 'FAIL';
  } else if (multiViolation) {
    verdict = 'FAIL';
  } else if (composite >= 0.75) {
    verdict = 'PASS';
  } else if (composite >= 0.55) {
    verdict = 'WARN';
  } else {
    verdict = 'FAIL';
  }

  return {
    composite: parseFloat(composite.toFixed(3)),
    verdict,
    checks,
    violations,
  };
}

// --- History management ---

function logQualityScore(text, result, session) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    session: session || null,
    verdict: result.verdict,
    composite: result.composite,
    text: text.slice(0, 200), // truncate for storage
    violations: result.violations.map(v => v.signal),
  };
  const line = JSON.stringify(entry) + '\n';

  // Append to history
  const existing = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, 'utf8') : '';
  const lines = existing.trim().split('\n').filter(Boolean);
  // Keep last 100 entries
  if (lines.length >= 100) {
    lines.splice(0, lines.length - 99);
  }
  lines.push(line.trim());
  writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');

  // Log violations
  if (result.violations.length > 0) {
    const violationLine = `${entry.ts} [${result.verdict}] score=${result.composite} violations=[${entry.violations.join(',')}] text="${text.slice(0, 80)}"\n`;
    const existingLog = existsSync(QUALITY_LOG) ? readFileSync(QUALITY_LOG, 'utf8') : '';
    writeFileSync(QUALITY_LOG, existingLog + violationLine);
  }
}

// --- CLI ---

const args = process.argv.slice(2);

if (args.includes('--check')) {
  const textIdx = args.indexOf('--check') + 1;
  const text = args[textIdx];
  if (!text) {
    console.error('Usage: post-quality-review.mjs --check "<text>"');
    process.exit(2);
  }

  const sessionNum = args.includes('--session')
    ? parseInt(args[args.indexOf('--session') + 1])
    : parseInt(process.env.SESSION_NUM || '0');

  const result = reviewPost(text);
  logQualityScore(text, result, sessionNum);

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Quality: ${result.verdict} (score: ${result.composite})`);
    if (result.violations.length > 0) {
      for (const v of result.violations) {
        console.log(`  - [${v.signal}] ${v.detail}`);
      }
    }
    if (result.verdict === 'FAIL') {
      console.log('\nPost BLOCKED. Rewrite to address violations above.');
    } else if (result.verdict === 'WARN') {
      console.log('\nPost has quality concerns. Consider revising.');
    }
  }

  process.exit(result.verdict === 'FAIL' ? 1 : 0);

} else if (args.includes('--audit')) {
  const sessionNum = parseInt(args[args.indexOf('--audit') + 1]);
  if (!sessionNum) {
    console.error('Usage: post-quality-review.mjs --audit <session_num>');
    process.exit(2);
  }

  if (!existsSync(HISTORY_FILE)) {
    console.log('No quality history yet.');
    process.exit(0);
  }

  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const sessionEntries = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.session === sessionNum) sessionEntries.push(entry);
    } catch { /* skip */ }
  }

  if (sessionEntries.length === 0) {
    console.log(`No quality records for session ${sessionNum}.`);
    process.exit(0);
  }

  console.log(`=== Quality Audit: Session ${sessionNum} ===\n`);
  let failCount = 0;
  for (const entry of sessionEntries) {
    const status = entry.verdict === 'FAIL' ? 'FAIL' : entry.verdict === 'WARN' ? 'WARN' : 'PASS';
    if (entry.verdict === 'FAIL') failCount++;
    console.log(`[${status}] score=${entry.composite} violations=[${(entry.violations || []).join(',')}]`);
    console.log(`  "${(entry.text || '').slice(0, 80)}..."\n`);
  }

  console.log(`Total: ${sessionEntries.length} posts, ${failCount} failures`);
  process.exit(failCount > 0 ? 1 : 0);

} else if (args.includes('--history')) {
  if (!existsSync(HISTORY_FILE)) {
    console.log('No quality history yet.');
    process.exit(0);
  }

  const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const recent = lines.slice(-10);
  console.log('=== Recent Quality Scores ===\n');
  for (const line of recent) {
    try {
      const entry = JSON.parse(line);
      const viol = (entry.violations || []).length > 0 ? ` violations=[${entry.violations.join(',')}]` : '';
      console.log(`s${entry.session || '?'} [${entry.verdict}] ${entry.composite}${viol} — "${(entry.text || '').slice(0, 60)}..."`);
    } catch { /* skip */ }
  }
} else {
  console.log('Usage:');
  console.log('  post-quality-review.mjs --check "<text>"     Check text quality before posting');
  console.log('  post-quality-review.mjs --audit <session>    Audit all posts from a session');
  console.log('  post-quality-review.mjs --history            Show recent quality scores');
  console.log('\nAdd --json for machine-readable output.');
}
