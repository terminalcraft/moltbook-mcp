#!/usr/bin/env node
// Lane CTF Bot — plays clawball.alphaleak.xyz
// Usage: node lane-ctf-bot.mjs [name] [poll_ms] [loop]
// Strategy: aggressive flag capture with stun/dash combos

const API = 'https://clawball.alphaleak.xyz/api';
const BOT_NAME = process.argv[2] || 'moltbook';
const POLL_MS = parseInt(process.argv[3]) || 1500;
const MAX_WAIT_S = 120; // max seconds to wait for opponent match
const MAX_STALE_S = 60; // max seconds waiting for opponent's move

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function getState(token) {
  const res = await fetch(`${API}/state/${token}`);
  return res.json();
}

function pickMove(s) {
  const me = s.you;
  const opp = s.opponent;
  const theirFlag = s.flags.theirs;
  const dirs = s.validMoves.directions;
  const abilities = s.validMoves.abilities;

  if (me.stunned) return { direction: 'stay', ability: 'none' };

  const towardOppHome = me.pos > opp.homePos ? 'left' : 'right';
  const towardMyHome = me.pos < me.homePos ? 'right' : 'left';
  const distToTheirFlag = Math.abs(me.pos - theirFlag.pos);
  const distToMyHome = Math.abs(me.pos - me.homePos);
  const distToOpp = Math.abs(me.pos - opp.pos);

  // CARRYING FLAG — rush home
  if (me.carryingFlag) {
    const dir = dirs.includes(towardMyHome) ? towardMyHome : 'stay';
    if (distToOpp <= 2 && abilities.includes('stun') && me.cooldowns.stun === 0)
      return { direction: dir, ability: 'stun' };
    if (abilities.includes('dash') && me.cooldowns.dash === 0 && distToMyHome > 2)
      return { direction: dir, ability: 'dash' };
    if (abilities.includes('jump') && me.cooldowns.jump === 0 && distToOpp <= 2)
      return { direction: dir, ability: 'jump' };
    return { direction: dir, ability: 'none' };
  }

  // OPPONENT CARRYING OUR FLAG — intercept
  if (opp.carryingFlag) {
    const toOpp = me.pos > opp.pos ? 'left' : me.pos < opp.pos ? 'right' : 'stay';
    const d = dirs.includes(toOpp) ? toOpp : 'stay';
    if (distToOpp <= 2 && abilities.includes('stun') && me.cooldowns.stun === 0)
      return { direction: d, ability: 'stun' };
    if (abilities.includes('dash') && me.cooldowns.dash === 0)
      return { direction: d, ability: 'dash' };
    return { direction: d, ability: 'none' };
  }

  // GO CAPTURE THEIR FLAG
  const dir = dirs.includes(towardOppHome) ? towardOppHome : 'stay';

  if (distToOpp <= 2 && abilities.includes('stun') && me.cooldowns.stun === 0)
    return { direction: dir, ability: 'stun' };
  if (abilities.includes('dash') && me.cooldowns.dash === 0 && distToTheirFlag > 3)
    return { direction: dir, ability: 'dash' };
  if (distToOpp <= 1 && abilities.includes('jump') && me.cooldowns.jump === 0)
    return { direction: dir, ability: 'jump' };
  if (opp.carryingFlag && abilities.includes('wall') && me.wallsRemaining > 0)
    return { direction: dir, ability: 'wall' };

  return { direction: dir, ability: 'none' };
}

async function playGame() {
  console.log(`[lane-ctf] Joining as "${BOT_NAME}"...`);
  const join = await post('/join', { name: BOT_NAME });

  if (!join.token) {
    console.error('[lane-ctf] Join failed:', JSON.stringify(join));
    return null;
  }

  const token = join.token;
  console.log(`[lane-ctf] Token: ${token} | status=${join.status} game=${join.gameId || 'pending'} player=${join.playerId || 'pending'}`);

  // Wait for match if status is "waiting"
  if (join.status === 'waiting') {
    console.log(`[lane-ctf] Waiting for opponent (max ${MAX_WAIT_S}s)...`);
    const deadline = Date.now() + MAX_WAIT_S * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const st = await getState(token);
      if (st.stateJson || st.status === 'matched' || st.gameId) {
        console.log(`[lane-ctf] Matched! game=${st.gameId} player=${st.playerId}`);
        break;
      }
    }
  }

  let turnPlayed = -1;
  let lastTurnTime = Date.now();

  for (let polls = 0; polls < 500; polls++) {
    const state = await getState(token);

    // Game over
    if (state.winner !== undefined && state.winner !== null) {
      const pid = state.playerId || join.playerId;
      const won = state.winner === 'draw' ? 'DRAW' :
        state.winner === pid ? 'WIN' : 'LOSS';
      const sj = state.stateJson || {};
      console.log(`[lane-ctf] Game over: ${won} | winner=${state.winner} you=${sj.you?.score || 0} opp=${sj.opponent?.score || 0}`);
      return { result: won, gameId: state.gameId || join.gameId };
    }

    // Submit move if it's our turn
    const sj = state.stateJson;
    if (sj && sj.phase === 'input' && sj.turn > turnPlayed) {
      const move = pickMove(sj);
      const flag = sj.you.carryingFlag ? ' [FLAG]' : '';
      console.log(`[lane-ctf] T${sj.turn}: pos=${sj.you.pos}${flag} → ${move.direction}+${move.ability}`);
      const result = await post('/move', { token, ...move });
      turnPlayed = sj.turn;
      lastTurnTime = Date.now();
      if (result.error) console.error(`[lane-ctf] Move error:`, result.error);
    }

    // Stale game detection
    if (Date.now() - lastTurnTime > MAX_STALE_S * 1000) {
      console.log(`[lane-ctf] Opponent stale for ${MAX_STALE_S}s, abandoning game`);
      return null;
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  console.log('[lane-ctf] Max polls reached');
  return null;
}

// Main
const mode = process.argv[4];
(async () => {
  if (mode === 'loop') {
    let wins = 0, losses = 0, draws = 0, abandoned = 0;
    while (true) {
      try {
        const r = await playGame();
        if (!r) { abandoned++; }
        else if (r.result === 'WIN') wins++;
        else if (r.result === 'LOSS') losses++;
        else draws++;
        console.log(`[lane-ctf] Record: ${wins}W/${losses}L/${draws}D/${abandoned}A`);
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        console.error('[lane-ctf] Error:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  } else {
    try {
      const r = await playGame();
      if (r) console.log(`[lane-ctf] Result: ${r.result}`);
      else console.log('[lane-ctf] No result (abandoned or no match)');
    } catch (e) {
      console.error('[lane-ctf] Error:', e.message);
    }
  }
})();
