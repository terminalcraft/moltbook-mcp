#!/usr/bin/env node
// Bluesky Agent Discovery Tool
// Finds autonomous AI agent accounts on Bluesky using multi-signal heuristics.
// Usage: node bsky-discover.cjs [--json] [--limit N] [--min-score N]

const { BskyAgent } = require('@atproto/api');
const fs = require('fs');
const path = require('path');

const PUBLIC_SERVICE = 'https://public.api.bsky.app';
const CATALOG_PATH = path.join(__dirname, 'bsky-agents.json');

// Search queries that find actual agents (not just agent researchers)
const SEARCH_QUERIES = [
  'bot autonomous AI',
  'I am a bot',
  'I am an AI agent',
  'automated account',
  'autonomous agent bluesky',
  'AI bot account',
  'claude agent',
  'GPT bot',
  'LLM bot bluesky',
  'AI assistant bot',
];

// Bio keywords strongly suggesting an actual bot/agent
const STRONG_BOT_KEYWORDS = [
  /\bi am a bot\b/i,
  /\bi('m| am) an? (ai |artificial |autonomous |llm )?agent\b/i,
  /\bautomated account\b/i,
  /\bautonomous ai\b/i,
  /\bbuilt (with|on|using) (claude|gpt|llama|gemini|openai|anthropic)/i,
  /\bpowered by (claude|gpt|llama|gemini|openai|anthropic)/i,
  /\bbot account\b/i,
  /\bnot a human\b/i,
  /\bfully autonomous\b/i,
  /\bai-powered bot\b/i,
  /\bautomated posts?\b/i,
];

// Weaker signals
const WEAK_BOT_KEYWORDS = [
  /\bbot\b/i,
  /\bagent\b/i,
  /\bautomated\b/i,
  /\bai-powered\b/i,
  /\bllm\b/i,
  /\bgenerative ai\b/i,
];

// Handle patterns common for bots
const BOT_HANDLE_PATTERNS = [
  /bot[s]?\./i,
  /\.bot$/i,
  /agent\./i,
  /ai-?\w*\./i,
  /auto\w*\./i,
];

// Signals for AI-powered autonomous agents specifically (vs RSS bots)
const AI_AGENT_KEYWORDS = [
  /\bautonomous ai\b/i,
  /\b(claude|gpt|llama|gemini|openai|anthropic)\b/i,
  /\bllm\b/i,
  /\blanguage model\b/i,
  /\bai.?agent\b/i,
  /\bai.?powered\b/i,
  /\bgenerative\b/i,
];

// Negative signals — likely humans working on agents
const HUMAN_KEYWORDS = [
  /\bphd\b/i,
  /\bprofessor\b/i,
  /\bresearcher\b/i,
  /\bstudent\b/i,
  /\bfounder\b/i,
  /\bceo\b/i,
  /\bcto\b/i,
  /\bdeveloper\b/i,
  /\bengineer\b/i,
  /\bbuilding\b/i,
  /\bi (work|research|study|build|create)\b/i,
  /\bmy (wife|husband|kid|dog|cat)\b/i,
  /\bfather|mother|parent|dad|mom\b/i,
];

function scoreProfile(actor) {
  const bio = (actor.description || '').toLowerCase();
  const handle = actor.handle || '';
  const name = (actor.displayName || '').toLowerCase();
  let score = 0;
  const signals = [];

  // Strong bot keywords in bio
  for (const re of STRONG_BOT_KEYWORDS) {
    if (re.test(actor.description || '')) {
      score += 30;
      signals.push(`strong_bio: ${re.source}`);
    }
  }

  // Weak bot keywords
  for (const re of WEAK_BOT_KEYWORDS) {
    if (re.test(actor.description || '')) {
      score += 5;
      signals.push(`weak_bio: ${re.source}`);
    }
  }

  // Handle patterns
  for (const re of BOT_HANDLE_PATTERNS) {
    if (re.test(handle)) {
      score += 15;
      signals.push(`handle: ${re.source}`);
    }
  }

  // Name contains "bot" or "ai agent"
  if (/bot/i.test(name)) { score += 10; signals.push('name_bot'); }
  if (/ai.*agent|agent.*ai/i.test(name)) { score += 15; signals.push('name_ai_agent'); }

  // Negative: human signals in bio
  for (const re of HUMAN_KEYWORDS) {
    if (re.test(actor.description || '')) {
      score -= 15;
      signals.push(`human: ${re.source}`);
    }
  }

  // Very few followers + following ratio (bots tend to have high following:followers or very few followers)
  // Not a strong signal on its own, just a minor factor

  // AI-agent specific score
  let aiScore = 0;
  for (const re of AI_AGENT_KEYWORDS) {
    if (re.test(actor.description || '') || re.test(actor.displayName || '')) {
      aiScore += 10;
    }
  }

  return { score: Math.max(0, score), aiScore, signals };
}

async function discover(opts = {}) {
  const limit = opts.limit || 50;
  const minScore = opts.minScore || 20;
  const agent = new BskyAgent({ service: PUBLIC_SERVICE });

  const candidates = new Map(); // handle -> { actor, score, signals }

  for (const q of SEARCH_QUERIES) {
    try {
      const { data } = await agent.app.bsky.actor.searchActors({
        q,
        limit: 25,
      });
      for (const actor of (data.actors || [])) {
        if (candidates.has(actor.handle)) continue;
        const { score, aiScore, signals } = scoreProfile(actor);
        candidates.set(actor.handle, { actor, score, aiScore, signals });
      }
    } catch (e) {
      // Rate limit or API error — skip this query
      if (e.status === 429) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Also search posts for "I am a bot" / "I am an AI agent" and extract authors
  try {
    const CREDS_PATH = path.join(process.env.HOME, '.config/moltbook/bluesky.json');
    if (fs.existsSync(CREDS_PATH)) {
      const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
      const authAgent = new BskyAgent({ service: 'https://bsky.social' });
      await authAgent.login(creds);

      for (const q of ['from:bot "I am"', '"I am a bot"', '"automated account"', '"AI agent" "my posts"']) {
        try {
          const { data } = await authAgent.app.bsky.feed.searchPosts({ q, limit: 20 });
          for (const post of (data.posts || [])) {
            const actor = post.author;
            if (candidates.has(actor.handle)) continue;
            // Boost score since they self-identified in a post
            const { score, aiScore, signals } = scoreProfile(actor);
            signals.push('self_identified_in_post');
            candidates.set(actor.handle, { actor, score: score + 20, aiScore, signals });
          }
        } catch (e) {
          // skip
        }
      }
    }
  } catch (e) {
    // No auth available, skip post search
  }

  // Sort by score, filter by minimum
  const results = [...candidates.values()]
    .filter(c => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const aiOnly = args.includes('--ai-only');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) || 50 : 50;
  const minIdx = args.indexOf('--min-score');
  const minScore = minIdx >= 0 ? parseInt(args[minIdx + 1]) || 20 : 20;

  console.error(`Discovering Bluesky agents (min score: ${minScore}, limit: ${limit}${aiOnly ? ', AI-only' : ''})...`);
  let results = await discover({ limit: limit * 2, minScore });
  if (aiOnly) {
    results = results.filter(r => r.aiScore > 0);
  }
  results = results.slice(0, limit);

  if (jsonMode) {
    const catalog = results.map(r => ({
      handle: r.actor.handle,
      displayName: r.actor.displayName || null,
      description: (r.actor.description || '').slice(0, 300),
      did: r.actor.did,
      score: r.score,
      aiScore: r.aiScore,
      signals: r.signals,
      followers: r.actor.followersCount || 0,
      following: r.actor.followsCount || 0,
      posts: r.actor.postsCount || 0,
      discoveredAt: new Date().toISOString(),
    }));
    // Save catalog
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
    console.log(JSON.stringify(catalog, null, 2));
    console.error(`\nSaved ${catalog.length} agents to ${CATALOG_PATH}`);
  } else {
    if (!results.length) {
      console.log('No agents found matching criteria.');
      return;
    }
    for (const r of results) {
      const bio = (r.actor.description || '').slice(0, 100).replace(/\n/g, ' ');
      console.log(`[${r.score}] @${r.actor.handle} (${r.actor.displayName || '-'})`);
      console.log(`    ${bio}`);
      console.log(`    signals: ${r.signals.slice(0, 4).join(', ')}`);
      console.log();
    }
    console.log(`${results.length} agents found.`);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
