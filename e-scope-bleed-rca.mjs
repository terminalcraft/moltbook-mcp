#!/usr/bin/env node
// e-scope-bleed-rca.mjs — Root cause analysis for E session scope bleed (wq-713)
//
// Analyzes WHY scope bleed happened in E sessions by categorizing commits as:
//   - bug-fix (reactive): fix: prefixed, fixing broken E session infrastructure
//   - feature (proactive): feat:/refactor: prefixed, building new things during E time
//   - config (accidental): state file changes, credential updates, JSON churn
//
// Usage:
//   node e-scope-bleed-rca.mjs              # analyze all E sessions with scope bleed
//   node e-scope-bleed-rca.mjs 1604         # analyze specific session
//   node e-scope-bleed-rca.mjs --json       # JSON output for audit integration
//
// Created: B#476 (wq-713)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const STATE_DIR = join(process.env.HOME || '/home/moltbot', '.config/moltbook');
const MCP_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

// --- Commit categorization rules ---

const CATEGORY_RULES = [
  {
    category: 'bug-fix',
    label: 'reactive',
    description: 'Fixing broken engagement infrastructure',
    match: (msg, files) => {
      if (/^fix[:(]/.test(msg)) return true;
      // Fixing verifiers/validators that broke during engagement
      if (files.some(f => /verify|validator|compliance/.test(f)) && /fix|handle|repair|patch/.test(msg)) return true;
      return false;
    }
  },
  {
    category: 'config',
    label: 'accidental',
    description: 'Credential or config changes during engagement',
    match: (msg, files) => {
      // Credential files, config JSON
      if (files.every(f => /credential|config|\.json$/.test(f))) return true;
      if (/^chore[:(]/.test(msg) && files.every(f => /\.json$/.test(f))) return true;
      return false;
    }
  },
  {
    category: 'feature',
    label: 'proactive',
    description: 'Building new functionality during E session time',
    match: (msg, files) => {
      if (/^feat[:(]/.test(msg)) return true;
      if (/^refactor[:(]/.test(msg)) return true;
      // New files created (not JSON state)
      if (files.some(f => /\.(mjs|js|sh|cjs)$/.test(f)) && !/^fix/.test(msg)) return true;
      return false;
    }
  }
];

// Engagement-related files that justify E session code changes
const E_SESSION_INFRA_FILES = [
  'engagement-trace.json',
  'engagement-intel.json',
  'verify-e-engagement.mjs',
  'audit-picker-compliance.mjs',
  'engage-orchestrator.mjs',
  'session-context.mjs',
  /credential/i,
  /engage/i,
  /picker/i
];

function isEngagementInfraFile(filename) {
  return E_SESSION_INFRA_FILES.some(pattern =>
    pattern instanceof RegExp ? pattern.test(filename) : filename === pattern
  );
}

// --- Git operations ---

function getAutoSnapshots() {
  try {
    const raw = execSync(
      'git log --format="%H %ai %s" --all',
      { cwd: MCP_DIR, encoding: 'utf8', timeout: 10000 }
    );
    return raw.trim().split('\n')
      .filter(line => line.includes('auto-snapshot post-session'))
      .map(line => {
        const [hash, date, time, tz, ...rest] = line.split(' ');
        return {
          hash,
          timestamp: new Date(`${date}T${time}${tz}`),
          message: rest.join(' ')
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

function getCommitsBetween(startHash, endHash) {
  try {
    const range = startHash ? `${startHash}..${endHash}` : endHash;
    const raw = execSync(
      `git log --format="COMMIT_SEP%n%H%n%s%n%b%nFILES_START" --name-only ${range}`,
      { cwd: MCP_DIR, encoding: 'utf8', timeout: 10000 }
    );

    const commits = [];
    const chunks = raw.split('COMMIT_SEP').filter(c => c.trim());

    for (const chunk of chunks) {
      const lines = chunk.trim().split('\n');
      if (lines.length < 2) continue;

      const hash = lines[0];
      const subject = lines[1];

      // Skip auto-snapshots
      if (subject.includes('auto-snapshot')) continue;

      // Find files after FILES_START marker
      const filesIdx = lines.indexOf('FILES_START');
      const files = filesIdx >= 0
        ? lines.slice(filesIdx + 1).filter(f => f.trim())
        : [];

      // Body is between subject and FILES_START
      const body = filesIdx >= 0
        ? lines.slice(2, filesIdx).filter(l => l.trim()).join(' ')
        : '';

      commits.push({ hash: hash.slice(0, 8), subject, body, files });
    }

    return commits;
  } catch {
    return [];
  }
}

function getCommitDiffStats(hash) {
  try {
    const raw = execSync(
      `git diff --stat ${hash}~1..${hash} 2>/dev/null`,
      { cwd: MCP_DIR, encoding: 'utf8', timeout: 5000 }
    );
    const lastLine = raw.trim().split('\n').pop() || '';
    const insertions = (lastLine.match(/(\d+) insertion/) || [, '0'])[1];
    const deletions = (lastLine.match(/(\d+) deletion/) || [, '0'])[1];
    return { insertions: parseInt(insertions), deletions: parseInt(deletions) };
  } catch {
    return { insertions: 0, deletions: 0 };
  }
}

// --- Session parsing ---

function parseESessions() {
  const historyPath = join(STATE_DIR, 'session-history.txt');
  if (!existsSync(historyPath)) return [];

  const content = readFileSync(historyPath, 'utf8');
  const lines = content.trim().split('\n').filter(l => l.trim());

  const sessions = [];
  for (const line of lines) {
    if (!line.includes('mode=E')) continue;

    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
    const sessionMatch = line.match(/s=(\d+)/);
    const buildMatch = line.match(/build=(\d+)\s+commit/);
    const costMatch = line.match(/cost=\$?([\d.]+)/);
    const durMatch = line.match(/dur=(\d+m\d+s)/);
    const filesMatch = line.match(/files=\[([^\]]*)\]/);
    const noteMatch = line.match(/note:\s*(.*)/);

    if (!sessionMatch) continue;

    sessions.push({
      date: dateMatch ? dateMatch[1] : 'unknown',
      session: parseInt(sessionMatch[1]),
      build_commits: buildMatch ? parseInt(buildMatch[1]) : 0,
      cost: costMatch ? parseFloat(costMatch[1]) : 0,
      duration: durMatch ? durMatch[1] : '?',
      files: filesMatch ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean) : [],
      note: noteMatch ? noteMatch[1] : ''
    });
  }

  return sessions;
}

// --- Core analysis ---

function categorizeCommit(commit) {
  const msg = commit.subject.toLowerCase();
  const files = commit.files;

  for (const rule of CATEGORY_RULES) {
    if (rule.match(msg, files)) {
      // Refine: check if bug-fix targets engagement infra (justified vs unjustified)
      const justified = files.some(f => isEngagementInfraFile(f));
      return {
        category: rule.category,
        label: rule.label,
        justified: rule.category === 'bug-fix' ? justified : rule.category === 'config',
        reason: rule.category === 'bug-fix' && justified
          ? 'Fixing engagement infrastructure during engagement session'
          : rule.category === 'bug-fix' && !justified
          ? 'Bug fix targeting non-engagement code — scope bleed'
          : rule.category === 'config'
          ? 'Config/credential change — likely necessary for engagement'
          : 'Proactive build work during engagement time — discipline failure'
      };
    }
  }

  // Default: unclassified
  return {
    category: 'unknown',
    label: 'unclassified',
    justified: false,
    reason: 'Could not categorize from commit message or files'
  };
}

function analyzeSession(sessionNum, snapshots) {
  // Find the session in history
  const sessions = parseESessions();
  const session = sessions.find(s => s.session === sessionNum);
  if (!session) return null;
  if (session.build_commits === 0) return { session: sessionNum, scope_bleed: false, commits: [] };

  // Find commits by looking at files touched during this session, time-bounded to session date
  const sessionFiles = session.files.filter(f => f !== '(none)');
  let commits = [];

  if (sessionFiles.length > 0) {
    const dateFilter = session.date !== 'unknown'
      ? `--after="${session.date}T00:00:00" --before="${session.date}T23:59:59"`
      : '';

    for (const file of sessionFiles) {
      try {
        const raw = execSync(
          `git log ${dateFilter} --format="%H %s" -- "${file}" 2>/dev/null | head -5`,
          { cwd: MCP_DIR, encoding: 'utf8', timeout: 5000 }
        );
        for (const line of raw.trim().split('\n').filter(l => l.trim())) {
          const [hash, ...msgParts] = line.split(' ');
          const msg = msgParts.join(' ');
          if (msg.includes('auto-snapshot')) continue;
          if (commits.find(c => c.hash === hash.slice(0, 8))) continue;

          let changedFiles = [file];
          try {
            const filesRaw = execSync(
              `git diff-tree --no-commit-id --name-only -r ${hash}`,
              { cwd: MCP_DIR, encoding: 'utf8', timeout: 5000 }
            );
            changedFiles = filesRaw.trim().split('\n').filter(f => f.trim());
          } catch {
            // use fallback
          }

          commits.push({
            hash: hash.slice(0, 8),
            subject: msg,
            body: '',
            files: changedFiles
          });
        }
      } catch { /* skip */ }
    }
  }

  // Categorize each commit
  const analyzed = commits.map(commit => {
    const stats = getCommitDiffStats(commit.hash);
    const classification = categorizeCommit(commit);
    return {
      hash: commit.hash,
      message: commit.subject,
      files_changed: commit.files,
      diff_size: stats,
      ...classification
    };
  });

  // Compute session-level verdict
  const categories = analyzed.map(a => a.category);
  const allJustified = analyzed.every(a => a.justified);
  const hasFeature = categories.includes('feature');
  const hasBugfix = categories.includes('bug-fix');

  let verdict;
  if (analyzed.length === 0) {
    verdict = 'no_commits_found';
  } else if (allJustified) {
    verdict = 'justified';
  } else if (hasFeature) {
    verdict = 'discipline_failure';
  } else if (hasBugfix && !hasFeature) {
    verdict = 'reactive_fix';
  } else {
    verdict = 'mixed';
  }

  return {
    session: `s${sessionNum}`,
    date: session.date,
    scope_bleed: true,
    build_commits: session.build_commits,
    cost: session.cost,
    duration: session.duration,
    verdict,
    all_justified: allJustified,
    commits: analyzed,
    summary: {
      bug_fix: categories.filter(c => c === 'bug-fix').length,
      feature: categories.filter(c => c === 'feature').length,
      config: categories.filter(c => c === 'config').length,
      unknown: categories.filter(c => c === 'unknown').length,
      justified: analyzed.filter(a => a.justified).length,
      unjustified: analyzed.filter(a => !a.justified).length
    }
  };
}

// --- Output formatting ---

function formatHuman(result) {
  if (!result) return 'Session not found in history.';
  if (!result.scope_bleed) return `${result.session}: No scope bleed (0 build commits).`;

  const lines = [];
  lines.push(`\n=== E Session Scope Bleed RCA: ${result.session} ===`);
  lines.push(`Date: ${result.date}  |  Cost: $${result.cost}  |  Duration: ${result.duration}`);
  lines.push(`Build commits: ${result.build_commits}  |  Verdict: ${result.verdict.toUpperCase()}`);
  lines.push('');

  if (result.commits.length === 0) {
    lines.push('  [!] No commits could be matched from git history.');
    lines.push('      Build count from session log but commits may have been squashed/rebased.');
  }

  for (const commit of result.commits) {
    const icon = commit.justified ? '[OK]' : '[!!]';
    lines.push(`  ${icon} ${commit.hash} ${commit.message}`);
    lines.push(`      Category: ${commit.category} (${commit.label})`);
    lines.push(`      Files: ${commit.files_changed.join(', ')}`);
    lines.push(`      Size: +${commit.diff_size.insertions}/-${commit.diff_size.deletions}`);
    lines.push(`      Reason: ${commit.reason}`);
    lines.push('');
  }

  lines.push('--- Summary ---');
  const s = result.summary;
  lines.push(`  Bug fixes: ${s.bug_fix}  Features: ${s.feature}  Config: ${s.config}  Unknown: ${s.unknown}`);
  lines.push(`  Justified: ${s.justified}  Unjustified: ${s.unjustified}`);
  lines.push(`  All justified: ${result.all_justified ? 'YES' : 'NO'}`);

  return lines.join('\n');
}

// --- Main ---

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const sessionArg = args.find(a => /^\d+$/.test(a));

const snapshots = getAutoSnapshots();

if (sessionArg) {
  // Analyze specific session
  const result = analyzeSession(parseInt(sessionArg), snapshots);
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHuman(result));
  }
} else {
  // Analyze all E sessions with scope bleed
  const eSessions = parseESessions().filter(s => s.build_commits > 0);

  if (eSessions.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({ sessions: [], total_bleed_sessions: 0 }));
    } else {
      console.log('No E sessions with scope bleed found in session history.');
    }
    process.exit(0);
  }

  const results = eSessions.map(s => analyzeSession(s.session, snapshots)).filter(Boolean);

  if (jsonMode) {
    // Compute aggregate stats for audit integration
    const aggregate = {
      total_bleed_sessions: results.length,
      verdicts: {
        justified: results.filter(r => r.verdict === 'justified').length,
        reactive_fix: results.filter(r => r.verdict === 'reactive_fix').length,
        discipline_failure: results.filter(r => r.verdict === 'discipline_failure').length,
        mixed: results.filter(r => r.verdict === 'mixed').length,
        no_commits_found: results.filter(r => r.verdict === 'no_commits_found').length
      },
      sessions: results
    };
    console.log(JSON.stringify(aggregate, null, 2));
  } else {
    for (const result of results) {
      console.log(formatHuman(result));
    }
  }
}
