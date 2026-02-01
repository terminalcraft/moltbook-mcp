#!/usr/bin/env node
// session-stats.cjs — Parse session summary files and output metrics
// Usage: node session-stats.cjs [--json] [--last N]

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOGS_DIR = path.join(os.homedir(), '.config/moltbook/logs');

function parseDuration(str) {
  if (!str) return 0;
  const m = str.match(/(\d+)m(\d+)s/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  const s = str.match(/(\d+)s/);
  if (s) return parseInt(s[1]);
  return 0;
}

function parseSummary(content, filename) {
  const lines = content.split('\n');
  const data = { file: filename };

  for (const line of lines) {
    const kv = line.match(/^([^:]+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    switch (key.trim()) {
      case 'Session': data.session = parseInt(val); break;
      case 'Start': data.start = val.trim(); break;
      case 'Duration': data.duration = val.trim(); data.durationSec = parseDuration(val.trim()); break;
      case 'Scan': data.scanMode = val.trim(); break;
      case 'Tools': data.toolCalls = parseInt(val); break;
      case 'Posts read': data.postsRead = parseInt(val); break;
      case 'Threads diffed': data.threadsDiffed = parseInt(val); break;
      case 'Upvotes': data.upvotes = parseInt(val); break;
      case 'Comments': data.comments = parseInt(val); break;
      case 'Build': data.buildInfo = val.trim(); break;
      case 'Files changed': data.filesChanged = val.trim().split(', ').filter(Boolean); break;
    }
  }

  // Extract session type from filename's log content or build info
  const dateMatch = filename.match(/^(\d{8})/);
  if (dateMatch) data.date = dateMatch[1];

  // Detect commits
  const commitMatch = content.match(/(\d+) commit/);
  if (commitMatch) data.commits = parseInt(commitMatch[1]);

  return data;
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const lastIdx = args.indexOf('--last');
  const lastN = lastIdx >= 0 ? parseInt(args[lastIdx + 1]) || 20 : null;

  // Read all summary files
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.summary'))
    .sort();

  const summaries = files.map(f => {
    const content = fs.readFileSync(path.join(LOGS_DIR, f), 'utf8');
    return parseSummary(content, f);
  }).filter(s => s.session);

  const selected = lastN ? summaries.slice(-lastN) : summaries;

  if (jsonMode) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  // Compute aggregates
  const totalSessions = selected.length;
  const totalDuration = selected.reduce((s, d) => s + (d.durationSec || 0), 0);
  const totalTools = selected.reduce((s, d) => s + (d.toolCalls || 0), 0);
  const totalCommits = selected.reduce((s, d) => s + (d.commits || 0), 0);
  const totalUpvotes = selected.reduce((s, d) => s + (d.upvotes || 0), 0);
  const totalComments = selected.reduce((s, d) => s + (d.comments || 0), 0);
  const totalPostsRead = selected.reduce((s, d) => s + (d.postsRead || 0), 0);

  const avgDuration = totalSessions > 0 ? Math.round(totalDuration / totalSessions) : 0;
  const avgTools = totalSessions > 0 ? Math.round(totalTools / totalSessions) : 0;

  console.log(`Session Stats (${totalSessions} sessions${lastN ? `, last ${lastN}` : ''}):`);
  console.log(`  Sessions: ${selected[0]?.session || '?'} → ${selected[selected.length - 1]?.session || '?'}`);
  console.log(`  Total duration: ${Math.floor(totalDuration / 60)}m${totalDuration % 60}s`);
  console.log(`  Avg duration: ${Math.floor(avgDuration / 60)}m${avgDuration % 60}s`);
  console.log(`  Tool calls: ${totalTools} total, ${avgTools} avg/session`);
  console.log(`  Commits: ${totalCommits}`);
  console.log(`  Posts read: ${totalPostsRead}`);
  console.log(`  Upvotes: ${totalUpvotes}`);
  console.log(`  Comments: ${totalComments}`);

  // Per-session breakdown (last 10)
  console.log(`\nRecent sessions:`);
  const recent = selected.slice(-10);
  for (const s of recent) {
    const parts = [`  #${s.session || '?'}`];
    parts.push(s.duration || '?');
    parts.push(`${s.toolCalls || 0} tools`);
    if (s.commits) parts.push(`${s.commits} commits`);
    if (s.upvotes) parts.push(`${s.upvotes}↑`);
    if (s.comments) parts.push(`${s.comments} comments`);
    if (s.filesChanged?.length) parts.push(`${s.filesChanged.length} files`);
    console.log(parts.join(' | '));
  }
}

main();
