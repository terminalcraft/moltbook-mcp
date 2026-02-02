#!/usr/bin/env node
/**
 * SHELLSWORD Bot — automated fencing game client
 * Game by Nox_CTF at https://clawball.alphaleak.xyz/shellsword/
 *
 * Moves: advance, retreat, lunge, parry
 * Win condition: first to 3 touches
 * Distance: starts at 4, lunge hits at dist ≤ 2 (50% chance)
 *
 * Usage:
 *   node shellsword-bot.mjs practice          # play vs practice bot
 *   node shellsword-bot.mjs join [name]        # join matchmaking queue
 *   node shellsword-bot.mjs rules              # fetch rules
 */

const BASE_URL = 'https://clawball.alphaleak.xyz/shellsword/api';
const AGENT_NAME = 'moltbook';

// --- HTTP helpers ---

async function api(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000), // blocking mode can hang up to 2 min
  };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    return { status: 0, data: null, error: err.cause?.code || err.message };
  }
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

// --- Strategy engine ---

/**
 * Choose a move based on game state.
 *
 * State from server (inferred from Chatr discussion):
 *   - distance: integer (starts ~4)
 *   - myScore / opponentScore: 0-3
 *   - turn: integer
 *
 * Strategy:
 *   1. If distance > 2: advance (close the gap for lunge range)
 *   2. If distance ≤ 2 and we're ahead or tied: lunge (50% to score)
 *   3. If distance ≤ 2 and we're behind: parry (defensive, hope to counter)
 *   4. If distance ≤ 1: retreat (too close, create space)
 *   5. Mix in parry occasionally to avoid predictability
 */
function chooseMove(state) {
  const { distance, myScore, opponentScore, turn } = state;

  // Critical: if opponent is at match point and close, play defensive
  if (opponentScore === 2 && distance <= 2) {
    return Math.random() < 0.6 ? 'parry' : 'retreat';
  }

  // At match point ourselves: be aggressive
  if (myScore === 2 && distance <= 2) {
    return 'lunge';
  }

  // Distance-based core strategy
  if (distance <= 1) {
    // Too close — retreat to create lunge opportunity
    return 'retreat';
  }

  if (distance <= 2) {
    // In lunge range — lunge with high probability, occasionally parry
    return Math.random() < 0.7 ? 'lunge' : 'parry';
  }

  // distance > 2: close the gap
  // Occasionally parry to bait opponent's lunge from too far
  return Math.random() < 0.85 ? 'advance' : 'parry';
}

// --- Game state parser ---

/**
 * Parse server response into normalized state.
 * We don't know the exact schema so we handle several possibilities.
 */
function parseState(data, myName) {
  // Try common field names
  const state = {
    distance: data.distance ?? data.dist ?? data.d ?? 4,
    myScore: 0,
    opponentScore: 0,
    turn: data.turn ?? data.round ?? 0,
    gameOver: data.gameOver ?? data.game_over ?? data.ended ?? false,
    winner: data.winner ?? null,
    token: data.token ?? null,
    message: data.message ?? data.msg ?? null,
    raw: data,
  };

  // Score extraction — try multiple schemas
  if (data.scores && typeof data.scores === 'object') {
    const keys = Object.keys(data.scores);
    for (const k of keys) {
      if (k === myName || k.toLowerCase() === myName.toLowerCase()) {
        state.myScore = data.scores[k];
      } else {
        state.opponentScore = data.scores[k];
      }
    }
  } else if (data.score !== undefined) {
    // Might be array [my, opp] or object {me, opponent}
    if (Array.isArray(data.score)) {
      state.myScore = data.score[0];
      state.opponentScore = data.score[1];
    } else if (typeof data.score === 'object') {
      state.myScore = data.score.me ?? data.score.player ?? 0;
      state.opponentScore = data.score.opponent ?? data.score.enemy ?? 0;
    }
  } else if (data.myScore !== undefined) {
    state.myScore = data.myScore;
    state.opponentScore = data.opponentScore ?? data.oppScore ?? 0;
  } else if (data.player_score !== undefined) {
    state.myScore = data.player_score;
    state.opponentScore = data.opponent_score ?? 0;
  }

  return state;
}

// --- Game loop ---

async function playGame(mode, name) {
  const playerName = name || AGENT_NAME;
  console.log(`[SHELLSWORD] Starting ${mode} game as "${playerName}"...`);

  // Join or start practice
  const endpoint = mode === 'practice' ? '/practice' : '/join';
  const joinRes = await api('POST', endpoint, { name: playerName });
  console.log(`[SHELLSWORD] Join response (${joinRes.status}):`, JSON.stringify(joinRes.data));

  if (joinRes.error || joinRes.status >= 400) {
    console.error('[SHELLSWORD] Failed to join:', joinRes.error || joinRes.data);
    return { success: false, error: joinRes.error || joinRes.data };
  }

  let token = joinRes.data?.token ?? joinRes.data?.game_token ?? null;
  let state = parseState(joinRes.data, playerName);

  if (!token && state.raw?.id) {
    token = state.raw.id;
  }

  if (!token) {
    console.error('[SHELLSWORD] No token received. Response:', joinRes.data);
    return { success: false, error: 'no token' };
  }

  console.log(`[SHELLSWORD] Token: ${token.substring(0, 8)}...`);

  // Game loop
  let turnCount = 0;
  const maxTurns = 30; // safety limit

  while (!state.gameOver && turnCount < maxTurns) {
    const move = chooseMove(state);
    console.log(`[SHELLSWORD] Turn ${turnCount}: d=${state.distance} score=${state.myScore}-${state.opponentScore} → ${move}`);

    const moveRes = await api('POST', '/move', { token, move });
    console.log(`[SHELLSWORD] Move response (${moveRes.status}):`, JSON.stringify(moveRes.data));

    if (moveRes.error || moveRes.status >= 400) {
      console.error('[SHELLSWORD] Move failed:', moveRes.error || moveRes.data);
      return { success: false, error: moveRes.error || moveRes.data, turns: turnCount };
    }

    state = parseState(moveRes.data, playerName);
    if (moveRes.data?.token) token = moveRes.data.token; // token might rotate
    turnCount++;
  }

  const won = state.winner === playerName || state.winner === 'player';
  console.log(`[SHELLSWORD] Game over! ${won ? 'WON' : 'LOST'} in ${turnCount} turns. Final: ${state.myScore}-${state.opponentScore}`);

  return {
    success: true,
    won,
    turns: turnCount,
    myScore: state.myScore,
    opponentScore: state.opponentScore,
    winner: state.winner,
  };
}

// --- Rules ---

async function fetchRules() {
  const res = await api('GET', '/rules');
  console.log('[SHELLSWORD] Rules:', JSON.stringify(res.data, null, 2));
  return res.data;
}

// --- Post-game attestation ---

async function attestResult(result) {
  if (!result.success) return;
  const outcome = result.won ? 'win' : 'loss';
  const task = `SHELLSWORD ${outcome} ${result.myScore}-${result.opponentScore} in ${result.turns} turns`;
  try {
    const res = await fetch('https://moltbook.com/api/registry/attest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: AGENT_NAME, attester: AGENT_NAME, task: task.slice(0, 300) }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) console.log('[SHELLSWORD] Registry attestation submitted');
    else console.log(`[SHELLSWORD] Registry attestation ${res.status}`);
  } catch (e) {
    console.log(`[SHELLSWORD] Registry attestation skipped: ${e.message}`);
  }
}

// --- CLI ---

const cmd = process.argv[2];

if (cmd === 'rules') {
  await fetchRules();
} else if (cmd === 'practice') {
  const r = await playGame('practice', process.argv[3] || AGENT_NAME);
  await attestResult(r);
} else if (cmd === 'join') {
  const r = await playGame('join', process.argv[3] || AGENT_NAME);
  await attestResult(r);
} else {
  console.log('Usage: node shellsword-bot.mjs <practice|join|rules> [name]');
}

// Export for use as module
export { playGame, fetchRules, chooseMove, parseState, BASE_URL, attestResult };
