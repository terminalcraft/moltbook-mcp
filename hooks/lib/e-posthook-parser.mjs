#!/usr/bin/env node
// e-posthook-parser.mjs — Extracted Phase 1 parser for E session posthook
//
// Parses engagement-intel.json, engagement-trace.json, e-phase-timing.json,
// session-history.txt, quality-scores.jsonl, and session summaries.
// Outputs JSON line prefixed with "JSON:" and shell variables prefixed with "VARS:".
//
// Extracted from 36-e-session-posthook_E.sh Phase 1 (R#302).
// Environment: SESSION_NUM, STATE_DIR, LOG_DIR, LOG_FILE (all required by caller).

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const session = parseInt(process.env.SESSION_NUM);
const stateDir = process.env.STATE_DIR || join(process.env.HOME, '.config/moltbook');
const logDir = process.env.LOG_DIR || join(stateDir, 'logs');
const logFile = process.env.LOG_FILE || '';
const summaryFile = logFile ? logFile.replace('.log', '.summary') : '';

function readJSON(filepath) {
  try { return JSON.parse(readFileSync(filepath, 'utf8')); } catch { return null; }
}

const result = {};

// --- Intel count ---
const intelData = readJSON(join(stateDir, 'engagement-intel.json'));
const intelEntries = Array.isArray(intelData) ? intelData : [];
result.intel_count = intelEntries.length;

// --- Trace for this session ---
const traceRaw = readJSON(join(stateDir, 'engagement-trace.json'));
let allTraces = [];
if (Array.isArray(traceRaw)) allTraces = traceRaw;
else if (traceRaw && typeof traceRaw === 'object') allTraces = [traceRaw];
const sessionTrace = allTraces.find(t => t.session === session) || null;

result.has_trace = sessionTrace !== null;
// Normalize platforms_engaged: may be strings or objects with .platform field
const rawPlatforms = sessionTrace ? (sessionTrace.platforms_engaged || []) : [];
result.trace_platforms_engaged = rawPlatforms.map(p => typeof p === 'string' ? p : (p && p.platform ? p.platform : String(p)));
// Keep full objects for detailed analysis
result.trace_platforms_engaged_full = rawPlatforms;
result.trace_skipped_platforms = sessionTrace ? (sessionTrace.skipped_platforms || []) : [];
result.trace_topics = sessionTrace ? (sessionTrace.topics || []) : [];
result.trace_agents = sessionTrace ? (sessionTrace.agents_interacted || []) : [];
result.trace_picker_mandate = sessionTrace ? (sessionTrace.picker_mandate || []) : [];

// Backup substitution telemetry (wq-865, wq-844 protocol)
const rawSubstitutions = sessionTrace ? (sessionTrace.backup_substitutions || []) : [];
result.backup_substitutions = rawSubstitutions;
result.backup_substitution_count = rawSubstitutions.length;

// --- Phase 2 reached? ---
let phase2Reached = false;
const timing = readJSON(join(stateDir, 'e-phase-timing.json'));
if (timing && Array.isArray(timing.phases)) {
  const phases = timing.phases;
  let lastP0 = -1;
  for (let i = 0; i < phases.length; i++) {
    if (phases[i].phase === '0') lastP0 = i;
  }
  const slice = lastP0 >= 0 ? phases.slice(lastP0) : phases;
  phase2Reached = slice.some(p => p.phase === '2');
}
result.phase2_reached = phase2Reached;

// --- Rate limit detection ---
let isRateLimited = false;
try {
  const summaries = readdirSync(logDir).filter(f => f.endsWith('.summary')).sort();
  for (let i = summaries.length - 1; i >= 0; i--) {
    const content = readFileSync(join(logDir, summaries[i]), 'utf8');
    if (content.includes('Session: ' + session)) {
      const lower = content.toLowerCase();
      if (content.includes('Tools: 0') && (lower.includes('hit your limit') || lower.includes('rate_limit') || lower.includes('resets')))
        isRateLimited = true;
      break;
    }
  }
} catch {}
result.is_rate_limited = isRateLimited;

// --- Platform failure analysis ---
let allPlatformsFailed = false;
if (phase2Reached && sessionTrace) {
  const engaged = sessionTrace.platforms_engaged || [];
  const skipped = sessionTrace.skipped_platforms || [];
  const mandate = sessionTrace.picker_mandate || [];
  if (mandate.length > 0 && engaged.length === 0 && skipped.length === mandate.length)
    allPlatformsFailed = true;
}
result.all_platforms_failed = allPlatformsFailed;

// Build platform_details string
let platformDetails = '';
if (phase2Reached && sessionTrace) {
  const skipped = sessionTrace.skipped_platforms || [];
  const engaged = sessionTrace.platforms_engaged || [];
  if (skipped.length > 0) {
    const reasons = skipped.filter(s => typeof s === 'object').map(s => (s.platform || '?') + ': ' + (s.reason || '?'));
    platformDetails = reasons.join('; ');
  }
  if (engaged.length === 0 && skipped.length > 0)
    platformDetails = 'ALL_FAILED: ' + platformDetails;
}
result.platform_details = platformDetails;

// --- Failure mode classification ---
let failureMode;
if (result.intel_count > 0) failureMode = 'none';
else if (isRateLimited) failureMode = 'rate_limit';
else if (!phase2Reached) failureMode = 'truncated_early';
else if (allPlatformsFailed) failureMode = 'platform_unavailable';
else if (sessionTrace) failureMode = 'trace_without_intel';
else if (phase2Reached) failureMode = 'agent_skip';
else failureMode = 'unknown';
result.failure_mode = failureMode;

// --- Session duration from summary ---
let totalSeconds = -1, durationStr = '';
if (summaryFile) {
  try {
    for (const line of readFileSync(summaryFile, 'utf8').split('\n')) {
      if (line.startsWith('Duration:')) {
        durationStr = line.split(/\s+/)[1].replace(/^~/, '');
        const mMatch = durationStr.match(/(\d+)m/);
        const sMatch = durationStr.match(/(\d+)s/);
        totalSeconds = (mMatch ? parseInt(mMatch[1]) * 60 : 0) + (sMatch ? parseInt(sMatch[1]) : 0);
        break;
      }
    }
  } catch {}
}
result.duration_str = durationStr;
result.total_seconds = totalSeconds;

// --- History note for this session ---
let currentNote = '';
const historyFile = join(stateDir, 'session-history.txt');
try {
  for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
    if (line.includes('s=' + session + ' ') && line.includes('note: ')) {
      currentNote = line.slice(line.indexOf('note: ') + 6).trim();
    }
  }
} catch {}
result.current_note = currentNote;

// --- E session count ---
let eCount = 0;
try {
  for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
    if (line.includes(' mode=E ')) eCount++;
  }
} catch {}
result.e_count = eCount;

// --- Quality scores ---
let qFails = 0, qWarns = 0, qTotal = 0;
try {
  for (const line of readFileSync(join(logDir, 'quality-scores.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.session === session) {
        qTotal++;
        if (entry.verdict === 'FAIL') qFails++;
        else if (entry.verdict === 'WARN') qWarns++;
      }
    } catch {}
  }
} catch {}
result.quality_session_fails = qFails;
result.quality_session_warns = qWarns;
result.quality_session_total = qTotal;

// --- Trace intel extraction data ---
let traceIntelData = null;
if (result.intel_count === 0 && sessionTrace) {
  const topics = sessionTrace.topics || [];
  const agents = sessionTrace.agents_interacted || [];
  const platforms = result.trace_platforms_engaged;
  if (topics.length > 0) {
    const platformStr = platforms.length ? platforms.join(', ') : 'unknown platform';
    const agentStr = agents.length ? agents.slice(0, 3).join(', ') : 'various agents';
    traceIntelData = {
      type: 'pattern',
      source: platformStr + ' (extracted from trace by checkpoint hook)',
      summary: 'Engagement on ' + platformStr + ' covering: ' + topics[0] + '. Agents: ' + agentStr + '.',
      actionable: 'Evaluate ' + platformStr + ' discussion topics for build opportunities in next E session',
      session, checkpoint: true, extracted_from_trace: true, failure_reason: failureMode
    };
  }
}
result.trace_intel_data = traceIntelData;

// --- Intel archive entries for trace-fallback ---
const archiveIntel = [];
const intelFile = join(stateDir, 'engagement-intel.json');
const archiveFile = join(stateDir, 'engagement-intel-archive.json');
for (const fp of [intelFile, archiveFile]) {
  try {
    const data = JSON.parse(readFileSync(fp, 'utf8'));
    const entries = Array.isArray(data) ? data : (data.entries || []);
    for (const e of entries) { if (e.session === session) archiveIntel.push(e); }
  } catch {}
}
result.archive_intel_count = archiveIntel.length;
result.archive_intel_platforms = [...new Set(archiveIntel.map(e => e.platform || e.source || 'unknown').filter(Boolean))];
result.archive_intel_topics = [...new Set(archiveIntel.map(e => (e.learned || e.summary || '').slice(0, 60)).filter(Boolean))].slice(0, 5);

// --- Output: JSON on first line, shell vars on subsequent lines ---
const jsonLine = JSON.stringify(result);
const boolStr = v => v ? 'true' : 'false';
const safeQuote = v => { const s = String(v == null ? '' : v); return "'" + s.replace(/'/g, "'\\''") + "'"; };

const shellVars = [
  'INTEL_COUNT=' + result.intel_count,
  'HAS_TRACE=' + boolStr(result.has_trace),
  'PHASE2_REACHED=' + boolStr(result.phase2_reached),
  'IS_RATE_LIMITED=' + boolStr(result.is_rate_limited),
  'ALL_PLATFORMS_FAILED=' + boolStr(result.all_platforms_failed),
  'FAILURE_MODE=' + safeQuote(result.failure_mode),
  'PLATFORM_DETAILS=' + safeQuote(result.platform_details),
  'TOTAL_SECONDS=' + result.total_seconds,
  'DURATION_STR=' + safeQuote(result.duration_str),
  'CURRENT_NOTE=' + safeQuote(result.current_note),
  'E_COUNT=' + result.e_count,
  'Q_FAILS=' + result.quality_session_fails,
  'Q_WARNS=' + result.quality_session_warns,
  'Q_TOTAL=' + result.quality_session_total,
  'ARCHIVE_INTEL_COUNT=' + result.archive_intel_count,
  'BACKUP_SUBSTITUTION_COUNT=' + result.backup_substitution_count,
];

console.log('JSON:' + jsonLine);
for (const v of shellVars) console.log('VARS:' + v);
