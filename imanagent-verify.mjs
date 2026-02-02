#!/usr/bin/env node
// imanagent.dev verification solver
// Requests a challenge, solves it, stores the token

import { writeFileSync, readFileSync, existsSync } from 'fs';

const API = 'https://imanagent.dev/v1';

async function getChallenge() {
  const resp = await fetch(`${API}/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

function solveJsonQuery(prompt, data) {
  const records = data.records;
  const p = prompt.toLowerCase();

  // "sum of 'value' for all records where 'status' is 'active'"
  const sumMatch = p.match(/sum of '(\w+)'.*where '(\w+)' is '(\w+)'/);
  if (sumMatch) {
    const [, field, filterKey, filterVal] = sumMatch;
    return records.filter(r => r[filterKey] === filterVal).reduce((s, r) => s + r[field], 0);
  }

  // "how many records have a 'score' above the average score"
  if (p.includes('how many') && p.includes('average')) {
    const fieldMatch = p.match(/'(\w+)'.*average/);
    if (fieldMatch) {
      const field = fieldMatch[1];
      const avg = records.reduce((s, r) => s + r[field], 0) / records.length;
      return records.filter(r => r[field] > avg).length;
    }
  }

  // "how many records have 'status' equal to 'active'"
  const countMatch = p.match(/how many.*'(\w+)'.*(?:equal to|is|=)\s*'(\w+)'/);
  if (countMatch) {
    return records.filter(r => r[countMatch[1]] === countMatch[2]).length;
  }

  // "what is the highest 'score'"
  const maxMatch = p.match(/highest '(\w+)'/);
  if (maxMatch) {
    return Math.max(...records.map(r => r[maxMatch[1]]));
  }

  // "what is the lowest 'score'"
  const minMatch = p.match(/lowest '(\w+)'/);
  if (minMatch) {
    return Math.min(...records.map(r => r[minMatch[1]]));
  }

  // "average 'score'"
  const avgMatch = p.match(/average '(\w+)'/);
  if (avgMatch) {
    const field = avgMatch[1];
    const avg = records.reduce((s, r) => s + r[field], 0) / records.length;
    return Math.round(avg * 100) / 100;
  }

  return null;
}

function solveTextExtract(prompt, data) {
  const text = data.text;
  const p = prompt.toLowerCase();

  // "list all codes and numbers"
  if (p.includes('codes') && p.includes('numbers')) {
    const matches = text.match(/[A-Z]{2,}-\d+|\b\d{3,}\b|#\d+|\b[A-Z0-9]{4,}\b/g);
    if (matches) return matches.join(', ');
  }

  // "how many times does X appear"
  const countMatch = p.match(/how many times.*['"](\w+)['"]/);
  if (countMatch) {
    const word = countMatch[1];
    const re = new RegExp(word, 'gi');
    return (text.match(re) || []).length;
  }

  // "extract all email addresses"
  if (p.includes('email')) {
    const emails = text.match(/[\w.-]+@[\w.-]+\.\w+/g);
    return (emails || []).join(', ');
  }

  return null;
}

function solveLogicPuzzle(prompt, data) {
  // Logic puzzles vary too much — skip for now
  return null;
}

async function solve() {
  const challenge = await getChallenge();
  console.log(`Challenge: ${challenge.challenge_id}`);
  console.log(`Type: ${challenge.challenge_type}`);
  console.log(`Prompt: ${challenge.prompt}`);

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
    console.log('Could not solve this challenge type/prompt. Try again.');
    process.exit(1);
  }

  console.log(`Answer: ${answer}`);

  const resp = await fetch(`${API}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challenge_id: challenge.challenge_id,
      answer: String(answer),
      context: 'moltbook agent verification for agent.json manifest',
    }),
    signal: AbortSignal.timeout(10000),
  });

  const result = await resp.text();
  console.log(`Status: ${resp.status}`);
  console.log(`Response: ${result}`);

  if (resp.ok) {
    try {
      const data = JSON.parse(result);
      if (data.token) {
        writeFileSync('/home/moltbot/.imanagent-token', JSON.stringify(data, null, 2));
        console.log('Token saved to ~/.imanagent-token');
      }
    } catch {}
  }
}

solve().catch(e => { console.error(e.message); process.exit(1); });
