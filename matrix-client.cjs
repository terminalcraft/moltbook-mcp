#!/usr/bin/env node
// Matrix client for Agent Commons server
// Usage: node matrix-client.cjs <command> [args]
// Commands: status, send <message>, rooms, messages [limit], register <user> <pass>

const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(process.env.HOME, '.config/secrets/matrix-credentials.json');
let creds;
try { creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch { console.error('No credentials found'); process.exit(1); }

const BASE = creds.homeserver;
const TOKEN = creds.access_token;
const ROOM = '!vhdFCkD4imtqk5QwIyVRVXmJt4eDacaowdS8tiqTn3E';

async function req(method, endpoint, body) {
  const opts = { method, headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${endpoint}`, opts);
  return r.json();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'status': {
      const v = await req('GET', '/_matrix/client/versions');
      const w = await req('GET', '/_matrix/client/v3/whoami');
      console.log(`Server: ${BASE}`);
      console.log(`User: ${w.user_id}`);
      console.log(`Versions: ${v.versions?.slice(-3).join(', ')}`);
      break;
    }
    case 'send': {
      const msg = args.join(' ');
      if (!msg) { console.error('Usage: send <message>'); process.exit(1); }
      const txn = Date.now().toString();
      const r = await req('PUT', `/_matrix/client/v3/rooms/${ROOM}/send/m.room.message/${txn}`, { msgtype: 'm.text', body: msg });
      console.log(`Sent: ${r.event_id}`);
      break;
    }
    case 'rooms': {
      const r = await req('GET', '/_matrix/client/v3/joined_rooms');
      console.log(`Joined rooms: ${r.joined_rooms?.length || 0}`);
      for (const rid of (r.joined_rooms || [])) {
        const state = await req('GET', `/_matrix/client/v3/rooms/${rid}/state/m.room.name`).catch(() => ({}));
        console.log(`  ${rid} - ${state.name || '(unnamed)'}`);
      }
      break;
    }
    case 'messages': {
      const limit = parseInt(args[0]) || 10;
      const r = await req('GET', `/_matrix/client/v3/rooms/${ROOM}/messages?dir=b&limit=${limit}`);
      const msgs = (r.chunk || []).reverse();
      for (const e of msgs) {
        if (e.type === 'm.room.message') {
          const ts = new Date(e.origin_server_ts).toISOString().slice(0, 16);
          console.log(`[${ts}] ${e.sender}: ${e.content?.body || ''}`);
        }
      }
      break;
    }
    case 'register': {
      const [user, pass] = args;
      if (!user || !pass) { console.error('Usage: register <username> <password>'); process.exit(1); }
      const r = await fetch(`${BASE}/_matrix/client/v3/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass, auth: { type: 'm.login.dummy' } })
      }).then(r => r.json());
      if (r.user_id) console.log(`Registered: ${r.user_id}`);
      else console.log(`Error: ${JSON.stringify(r)}`);
      break;
    }
    default:
      console.log('Commands: status, send <msg>, rooms, messages [limit], register <user> <pass>');
  }
}

main().catch(e => console.error(e.message));
