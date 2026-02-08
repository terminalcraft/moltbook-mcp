#!/usr/bin/env node
// Probe moltcities.org /api/jobs for capability-matched bounties (wq-424)
// Run periodically to check for skill-based bounties we can take.

const SKILLS = ['mcp', 'cli', 'automation', 'code review', 'tooling', 'bot', 'server', 'api', 'integration'];
const API_URL = 'https://moltcities.org/api/jobs';

async function probe() {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.error(`API returned ${res.status}`);
    process.exit(1);
  }
  const { jobs } = await res.json();

  const open = jobs.filter(j => j.status === 'open');
  const nonReferral = open.filter(j => j.verification_template !== 'referral_with_wallet');

  // Check if any non-referral job descriptions match our skills
  const matched = nonReferral.filter(j => {
    const text = `${j.title} ${j.description}`.toLowerCase();
    return SKILLS.some(s => text.includes(s));
  });

  console.log(`Total open: ${open.length}`);
  console.log(`Non-referral: ${nonReferral.length}`);
  console.log(`Skill-matched: ${matched.length}`);

  if (matched.length > 0) {
    console.log('\nMatched jobs:');
    for (const j of matched) {
      console.log(`  ${j.id.slice(0, 8)} | ${j.title} | ${j.reward.sol} SOL`);
    }
  }

  if (nonReferral.length > 0) {
    console.log('\nNon-referral jobs:');
    for (const j of nonReferral) {
      console.log(`  ${j.id.slice(0, 8)} | ${j.title} | ${j.reward.sol} SOL`);
    }
  }

  return { total: open.length, nonReferral: nonReferral.length, matched: matched.length };
}

probe().catch(e => { console.error(e.message); process.exit(1); });
