// spam-detector.mjs — Cross-platform spam/low-value agent detection for E sessions
// Helps filter known spam patterns before engagement decisions
// wq-339

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_DIR = join(process.env.HOME || '/home/moltbot', '.config/moltbook');
const SPAM_REGISTRY_PATH = join(CONFIG_DIR, 'spam-registry.json');

// Known spam patterns (hardcoded baseline)
const BASELINE_PATTERNS = [
  { pattern: /^\[LYRA\] Reviewed agent discussions/i, reason: 'template-loop', source: 'chatr-observation' },
  { pattern: /Think your one daily post can make/i, reason: 'promo-spam', source: 'chatr-observation' },
  { pattern: /Can't post yet\? Claw posts on/i, reason: 'promo-spam', source: 'chatr-observation' },
  { pattern: /One post daily\. \d+ winners/i, reason: 'promo-spam', source: 'chatr-observation' },
];

// Load or initialize spam registry
function loadRegistry() {
  if (existsSync(SPAM_REGISTRY_PATH)) {
    try {
      return JSON.parse(readFileSync(SPAM_REGISTRY_PATH, 'utf8'));
    } catch { /* fallthrough */ }
  }
  return {
    version: 1,
    updated: new Date().toISOString(),
    agents: {},      // agent_id -> { reason, first_seen, count, platforms }
    patterns: [],    // { pattern_str, reason, source, count }
  };
}

// Save registry
function saveRegistry(registry) {
  registry.updated = new Date().toISOString();
  writeFileSync(SPAM_REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

// Check if content matches known spam patterns
export function isSpamContent(content) {
  if (!content) return { spam: false };

  for (const p of BASELINE_PATTERNS) {
    if (p.pattern.test(content)) {
      return { spam: true, reason: p.reason, source: p.source };
    }
  }

  const registry = loadRegistry();
  for (const p of registry.patterns) {
    try {
      if (new RegExp(p.pattern_str, 'i').test(content)) {
        return { spam: true, reason: p.reason, source: 'registry' };
      }
    } catch { /* invalid regex, skip */ }
  }

  return { spam: false };
}

// Check if agent is known spammer
export function isSpamAgent(agentId) {
  if (!agentId) return { spam: false };

  const normalized = agentId.toLowerCase().replace(/^@/, '');
  const registry = loadRegistry();

  if (registry.agents[normalized]) {
    const info = registry.agents[normalized];
    return {
      spam: true,
      reason: info.reason,
      count: info.count,
      platforms: info.platforms
    };
  }

  return { spam: false };
}

// Report a spam agent (called when E session detects spam)
export function reportSpamAgent(agentId, platform, reason = 'manual-report') {
  if (!agentId) return { success: false, error: 'No agent ID' };

  const normalized = agentId.toLowerCase().replace(/^@/, '');
  const registry = loadRegistry();

  if (!registry.agents[normalized]) {
    registry.agents[normalized] = {
      reason,
      first_seen: new Date().toISOString(),
      count: 1,
      platforms: [platform]
    };
  } else {
    registry.agents[normalized].count++;
    if (!registry.agents[normalized].platforms.includes(platform)) {
      registry.agents[normalized].platforms.push(platform);
    }
  }

  saveRegistry(registry);
  return { success: true, agent: normalized, count: registry.agents[normalized].count };
}

// Report a spam pattern (for learning new patterns)
export function reportSpamPattern(patternStr, reason, source = 'session-observation') {
  if (!patternStr) return { success: false, error: 'No pattern' };

  // Validate regex
  try {
    new RegExp(patternStr, 'i');
  } catch (e) {
    return { success: false, error: `Invalid regex: ${e.message}` };
  }

  const registry = loadRegistry();

  const existing = registry.patterns.find(p => p.pattern_str === patternStr);
  if (existing) {
    existing.count++;
    existing.last_seen = new Date().toISOString();
  } else {
    registry.patterns.push({
      pattern_str: patternStr,
      reason,
      source,
      count: 1,
      added: new Date().toISOString()
    });
  }

  saveRegistry(registry);
  return { success: true, pattern: patternStr };
}

// Get spam statistics for reporting
export function getSpamStats() {
  const registry = loadRegistry();

  return {
    updated: registry.updated,
    known_spam_agents: Object.keys(registry.agents).length,
    custom_patterns: registry.patterns.length,
    baseline_patterns: BASELINE_PATTERNS.length,
    top_offenders: Object.entries(registry.agents)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([id, info]) => ({ agent: id, count: info.count, reason: info.reason }))
  };
}

// Filter a list of agents, removing known spammers
export function filterSpamAgents(agents) {
  if (!Array.isArray(agents)) return { filtered: [], removed: [] };

  const filtered = [];
  const removed = [];

  for (const agent of agents) {
    const id = typeof agent === 'string' ? agent : agent.agent_id || agent.id || agent.name;
    const check = isSpamAgent(id);
    if (check.spam) {
      removed.push({ agent: id, reason: check.reason });
    } else {
      filtered.push(agent);
    }
  }

  return { filtered, removed };
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'check-agent': {
      const agentId = process.argv[3];
      if (!agentId) {
        console.log('Usage: node spam-detector.mjs check-agent <agent_id>');
        process.exit(1);
      }
      const result = isSpamAgent(agentId);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'check-content': {
      const content = process.argv.slice(3).join(' ');
      if (!content) {
        console.log('Usage: node spam-detector.mjs check-content <message text>');
        process.exit(1);
      }
      const result = isSpamContent(content);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'report-agent': {
      const [agentId, platform, reason] = process.argv.slice(3);
      if (!agentId || !platform) {
        console.log('Usage: node spam-detector.mjs report-agent <agent_id> <platform> [reason]');
        process.exit(1);
      }
      const result = reportSpamAgent(agentId, platform, reason || 'cli-report');
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'report-pattern': {
      const [patternStr, reason] = process.argv.slice(3);
      if (!patternStr || !reason) {
        console.log('Usage: node spam-detector.mjs report-pattern <regex> <reason>');
        process.exit(1);
      }
      const result = reportSpamPattern(patternStr, reason, 'cli');
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'stats': {
      const stats = getSpamStats();
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    case 'filter': {
      // Read agent list from stdin
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        try {
          const agents = JSON.parse(input);
          const result = filterSpamAgents(agents);
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          console.error('Error parsing input:', e.message);
          process.exit(1);
        }
      });
      break;
    }

    default:
      console.log(`spam-detector.mjs — Cross-platform spam detection for E sessions

Commands:
  check-agent <id>              Check if agent is known spammer
  check-content <text>          Check if content matches spam patterns
  report-agent <id> <platform>  Report a spam agent
  report-pattern <regex> <why>  Report a spam pattern
  stats                         Show spam statistics
  filter                        Filter agent list (read JSON from stdin)

Examples:
  node spam-detector.mjs check-agent LYRA2
  node spam-detector.mjs check-content "[LYRA] Reviewed agent discussions"
  node spam-detector.mjs report-agent spambot chatr template-spam
  node spam-detector.mjs stats
`);
  }
}
