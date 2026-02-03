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

// Color lightness ordering (light to dark) for comparative clues
const COLOR_LIGHTNESS = {
  white: 100, yellow: 97, pink: 80, orange: 70,
  green: 55, red: 53, blue: 45, purple: 38, brown: 30, black: 0,
};

function getColorOrder(color) {
  return COLOR_LIGHTNESS[color.toLowerCase()] ?? 50;
}

function solveLogicPuzzle(prompt, data) {
  // Parse constraint-based logic puzzles
  // Format: "Based on the clues below, what <attr> does <person> have?"
  // data.clues is an array of clue strings
  // data.entities is the list of people/things
  // data.attributes is { attrName: [values] }
  const clues = data?.clues || [];
  const entities = data?.entities || [];
  const attributes = data?.attributes || data?.categories || {};
  const p = prompt.toLowerCase();

  // Extract question: "what color does David have?"
  const qMatch = p.match(/what (\w+) does (\w+) have/);
  if (!qMatch || !clues.length) return null;

  const [, targetAttr, targetPerson] = qMatch;
  const targetPersonCap = targetPerson.charAt(0).toUpperCase() + targetPerson.slice(1);

  // Get people list - try entities first, then fallback to categories
  const people = entities.length ? entities : (
    attributes.person || attributes.people || attributes.name || attributes.names || []
  );
  if (!people.length) return null;

  // Get all attribute types we need to assign
  const attrNames = Object.keys(attributes);
  if (!attrNames.includes(targetAttr) || !attributes[targetAttr]?.length) return null;

  // For multi-attribute puzzles, we need to try all combinations
  // Build all possible assignments for each attribute
  const attrPerms = {};
  for (const attr of attrNames) {
    const vals = attributes[attr];
    if (vals.length <= 6) {
      attrPerms[attr] = permutations(vals);
    } else {
      return null; // Too many values
    }
  }

  // Try all combinations of attribute assignments
  const tryAssignments = (attrIdx, assignments) => {
    if (attrIdx >= attrNames.length) {
      // Check if this full assignment satisfies all clues
      if (checkCluesMultiAttr(clues, people, assignments)) {
        return assignments[targetAttr][targetPersonCap];
      }
      return null;
    }

    const attr = attrNames[attrIdx];
    for (const perm of attrPerms[attr]) {
      const attrAssign = {};
      people.forEach((person, i) => { attrAssign[person] = perm[i]; });
      assignments[attr] = attrAssign;
      const result = tryAssignments(attrIdx + 1, assignments);
      if (result !== null) return result;
    }
    return null;
  };

  // Limit combinatorial explosion: max 2 attributes or small value sets
  const totalPerms = attrNames.reduce((acc, attr) => acc * (attrPerms[attr]?.length || 1), 1);
  if (totalPerms > 1000) return null; // Too complex for brute force

  return tryAssignments(0, {});
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

// Multi-attribute clue checker for logic puzzles
// assignments = { attrName: { Person: value, ... }, ... }
function checkCluesMultiAttr(clues, people, assignments) {
  // Build reverse lookup: for each attr, value -> person
  const valueToPerson = {};
  for (const [attr, assign] of Object.entries(assignments)) {
    valueToPerson[attr] = {};
    for (const [person, val] of Object.entries(assign)) {
      valueToPerson[attr][val.toLowerCase()] = person;
    }
  }

  for (const clue of clues) {
    const c = clue.toLowerCase();

    // "X's color is lighter than Y's" or "X's color is darker than Y's"
    const lighterMatch = c.match(/(\w+)'s color is lighter than (\w+)'s/);
    if (lighterMatch) {
      const [, p1, p2] = lighterMatch;
      const person1 = capitalize(p1), person2 = capitalize(p2);
      if (assignments.color?.[person1] && assignments.color?.[person2]) {
        const order1 = getColorOrder(assignments.color[person1]);
        const order2 = getColorOrder(assignments.color[person2]);
        if (order1 <= order2) return false; // lighter means higher lightness value
      }
    }

    const darkerMatch = c.match(/(\w+)'s color is darker than (\w+)'s/);
    if (darkerMatch) {
      const [, p1, p2] = darkerMatch;
      const person1 = capitalize(p1), person2 = capitalize(p2);
      if (assignments.color?.[person1] && assignments.color?.[person2]) {
        const order1 = getColorOrder(assignments.color[person1]);
        const order2 = getColorOrder(assignments.color[person2]);
        if (order1 >= order2) return false; // darker means lower lightness value
      }
    }

    // "The person with the X <attr> does not have the Y <attr2>"
    // e.g., "The person with the dog pet does not have the yellow color"
    const crossMatch = c.match(/the person with the (\w+) (\w+) does not have the (\w+) (\w+)/);
    if (crossMatch) {
      const [, val1, attr1, val2, attr2] = crossMatch;
      const person1 = valueToPerson[attr1]?.[val1];
      if (person1 && assignments[attr2]?.[person1]?.toLowerCase() === val2) return false;
    }

    // "The person with the X <attr> has the Y <attr2>"
    const crossHasMatch = c.match(/the person with the (\w+) (\w+) has the (\w+) (\w+)/);
    if (crossHasMatch) {
      const [, val1, attr1, val2, attr2] = crossHasMatch;
      const person1 = valueToPerson[attr1]?.[val1];
      if (person1 && assignments[attr2]?.[person1]?.toLowerCase() !== val2) return false;
    }

    // "<Person> has <value>" (for any attribute)
    const hasMatch = c.match(/^(\w+) has (?:the )?(\w+)(?:\s|$|\.)/);
    if (hasMatch && !c.includes("does not")) {
      const [, person, value] = hasMatch;
      const personCap = capitalize(person);
      // Check all attributes for this value
      let found = false;
      for (const [attr, assign] of Object.entries(assignments)) {
        if (assign[personCap]?.toLowerCase() === value) found = true;
      }
      if (!found && Object.values(assignments).some(a => a[personCap] !== undefined)) {
        // Person exists but doesn't have this value in any attribute
        return false;
      }
    }

    // "<Person> does not have <value>"
    const notMatch = c.match(/(\w+) does not have (?:the )?(\w+)/);
    if (notMatch) {
      const [, person, value] = notMatch;
      const personCap = capitalize(person);
      for (const [attr, assign] of Object.entries(assignments)) {
        if (assign[personCap]?.toLowerCase() === value) return false;
      }
    }

    // "<Person>'s <attr> is not <value>"
    const isNotMatch = c.match(/(\w+)'s (\w+) is not (\w+)/);
    if (isNotMatch) {
      const [, person, attr, value] = isNotMatch;
      const personCap = capitalize(person);
      if (assignments[attr]?.[personCap]?.toLowerCase() === value) return false;
    }

    // "<Person>'s <attr> is <value>"
    const isMatch = c.match(/(\w+)'s (\w+) is (\w+)/);
    if (isMatch && !c.includes("is not")) {
      const [, person, attr, value] = isMatch;
      const personCap = capitalize(person);
      if (assignments[attr]?.[personCap] && assignments[attr][personCap].toLowerCase() !== value) return false;
    }
  }
  return true;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
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
