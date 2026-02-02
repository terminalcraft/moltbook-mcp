#!/usr/bin/env node
// imanagent.dev verification solver
// Requests a challenge, solves it, stores the token
// Retries up to MAX_ATTEMPTS if it gets an unsolvable challenge type

import { writeFileSync, readFileSync, existsSync } from 'fs';

const API = 'https://imanagent.dev/v1';
const TOKEN_PATH = '/home/moltbot/.imanagent-token';
const MAX_ATTEMPTS = 10;

async function getChallenge() {
  const resp = await fetch(`${API}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

async function verifyToken(token) {
  const resp = await fetch(`${API}/token/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: resp.status, data: await resp.json() };
}

function solveJsonQuery(prompt, data) {
  const records = data.records;
  const p = prompt.toLowerCase();

  const sumMatch = p.match(/sum of '(\w+)'.*where '(\w+)' is '(\w+)'/);
  if (sumMatch) {
    const [, field, filterKey, filterVal] = sumMatch;
    return records.filter(r => r[filterKey] === filterVal).reduce((s, r) => s + r[field], 0);
  }

  if (p.includes('how many') && p.includes('average')) {
    const fieldMatch = p.match(/'(\w+)'.*average/);
    if (fieldMatch) {
      const field = fieldMatch[1];
      const avg = records.reduce((s, r) => s + r[field], 0) / records.length;
      return records.filter(r => r[field] > avg).length;
    }
  }

  const countMatch = p.match(/how many.*'(\w+)'.*(?:equal to|is|=)\s*'(\w+)'/);
  if (countMatch) {
    return records.filter(r => r[countMatch[1]] === countMatch[2]).length;
  }

  const maxMatch = p.match(/highest '(\w+)'/);
  if (maxMatch) {
    return Math.max(...records.map(r => r[maxMatch[1]]));
  }

  const minMatch = p.match(/lowest '(\w+)'/);
  if (minMatch) {
    return Math.min(...records.map(r => r[minMatch[1]]));
  }

  const avgMatch = p.match(/average '(\w+)'/);
  if (avgMatch) {
    const field = avgMatch[1];
    const avg = records.reduce((s, r) => s + r[field], 0) / records.length;
    return Math.round(avg * 100) / 100;
  }

  // "product of 'field' where..."
  const prodMatch = p.match(/product of '(\w+)'.*where '(\w+)' is '(\w+)'/);
  if (prodMatch) {
    const [, field, filterKey, filterVal] = prodMatch;
    return records.filter(r => r[filterKey] === filterVal).reduce((s, r) => s * r[field], 1);
  }

  // "median 'field'"
  const medMatch = p.match(/median '(\w+)'/);
  if (medMatch) {
    const vals = records.map(r => r[medMatch[1]]).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }

  return null;
}

function solveTextExtract(prompt, data) {
  const text = data.text;
  const p = prompt.toLowerCase();

  if (p.includes('codes') && p.includes('numbers')) {
    const matches = text.match(/[A-Z]{2,}-\d+|\b\d{3,}\b|#\d+|\b[A-Z0-9]{4,}\b/g);
    if (matches) return matches.join(', ');
  }

  const countMatch = p.match(/how many times.*['"](\w+)['"]/);
  if (countMatch) {
    const word = countMatch[1];
    const re = new RegExp(word, 'gi');
    return (text.match(re) || []).length;
  }

  if (p.includes('email')) {
    const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
    return (emails || []).join(', ');
  }

  // "extract all URLs"
  if (p.includes('url')) {
    const urls = text.match(/https?:\/\/[^\s)]+/g);
    return (urls || []).join(', ');
  }

  // word count
  if (p.includes('how many words')) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  return null;
}

function solveLogicPuzzle(prompt, data) {
  // Parse constraint-based logic puzzles
  // Format: "Based on the clues below, what <attr> does <person> have?"
  // data.clues is an array of clue strings, data.categories describes the puzzle space
  const clues = data?.clues || [];
  const categories = data?.categories || {};
  const p = prompt.toLowerCase();

  // Extract question: "what color does David have?"
  const qMatch = p.match(/what (\w+) does (\w+) have/);
  if (!qMatch || !clues.length) return null;

  const [, targetAttr, targetPerson] = qMatch;

  // Build assignment possibilities
  const people = categories.person || categories.people || categories.name || categories.names || [];
  const attrValues = categories[targetAttr] || [];
  if (!people.length || !attrValues.length) return null;

  // Brute force: try all permutations for small puzzles
  if (attrValues.length <= 5) {
    const perms = permutations(attrValues);
    for (const perm of perms) {
      const assignment = {};
      people.forEach((person, i) => { assignment[person] = perm[i]; });
      if (checkClues(clues, assignment, targetAttr)) {
        return assignment[targetPerson];
      }
    }
  }

  return null;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

function checkClues(clues, assignment, attr) {
  for (const clue of clues) {
    const c = clue.toLowerCase();
    // "<Person> has <value>"
    const hasMatch = c.match(/(\w+) has (\w+)/);
    if (hasMatch) {
      const [, person, value] = hasMatch;
      const cap = person.charAt(0).toUpperCase() + person.slice(1);
      if (assignment[cap] !== undefined && assignment[cap].toLowerCase() !== value) return false;
    }
    // "<Person> does not have <value>"
    const notMatch = c.match(/(\w+) does not have (\w+)/);
    if (notMatch) {
      const [, person, value] = notMatch;
      const cap = person.charAt(0).toUpperCase() + person.slice(1);
      if (assignment[cap] !== undefined && assignment[cap].toLowerCase() === value) return false;
    }
    // "<Person>'s <attr> is not <value>"
    const isNotMatch = c.match(/(\w+)'s \w+ is not (\w+)/);
    if (isNotMatch) {
      const [, person, value] = isNotMatch;
      const cap = person.charAt(0).toUpperCase() + person.slice(1);
      if (assignment[cap] !== undefined && assignment[cap].toLowerCase() === value) return false;
    }
  }
  return true;
}

async function submitAnswer(challengeId, answer) {
  const resp = await fetch(`${API}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge_id: challengeId,
      answer: String(answer),
      context: 'moltbook agent verification for agent.json manifest',
    }),
    signal: AbortSignal.timeout(10000),
  });
  return { status: resp.status, text: await resp.text() };
}

// Check if current token is still valid
export async function checkTokenStatus() {
  try {
    const tokenData = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
    const expires = new Date(tokenData.token_expires_at);
    const now = new Date();
    if (now >= expires) {
      return { valid: false, reason: 'expired', expires_at: tokenData.token_expires_at };
    }
    // Verify with API
    const result = await verifyToken(tokenData.token);
    return {
      valid: result.data.valid === true,
      token: tokenData.token,
      verification_url: tokenData.verification_url,
      verification_code: tokenData.verification_code,
      expires_at: tokenData.token_expires_at,
      api_response: result.data,
    };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

// Main solve loop with retry
export async function solveAndVerify() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const challenge = await getChallenge();
    console.log(`[${attempt}/${MAX_ATTEMPTS}] Challenge: ${challenge.challenge_id} (${challenge.challenge_type})`);

    let answer;
    switch (challenge.challenge_type) {
      case 'json_query':
        answer = solveJsonQuery(challenge.prompt, challenge.data);
        break;
      case 'text_extract':
        answer = solveTextExtract(challenge.prompt, challenge.data);
        break;
      case 'logic_puzzle':
        answer = solveLogicPuzzle(challenge.prompt, challenge.data);
        break;
    }

    if (answer === null || answer === undefined) {
      console.log(`  Unsolvable prompt: ${challenge.prompt.slice(0, 80)}...`);
      continue;
    }

    console.log(`  Answer: ${answer}`);
    const { status, text } = await submitAnswer(challenge.challenge_id, answer);
    console.log(`  Status: ${status}`);

    if (status === 200) {
      try {
        const data = JSON.parse(text);
        if (data.valid && data.token) {
          writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
          console.log('  Token saved.');
          return { success: true, ...data };
        }
      } catch {}
    }
    console.log(`  Response: ${text.slice(0, 200)}`);
  }
  return { success: false, reason: `Failed after ${MAX_ATTEMPTS} attempts` };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('imanagent-verify.mjs')) {
  const cmd = process.argv[2];
  if (cmd === 'status') {
    checkTokenStatus().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exit(1); });
  } else {
    solveAndVerify().then(r => {
      if (!r.success) process.exit(1);
    }).catch(e => { console.error(e.message); process.exit(1); });
  }
}
