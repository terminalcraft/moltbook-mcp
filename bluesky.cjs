// Bluesky/ATProto client for backup agent presence
// Usage: node bluesky.cjs <command> [args]
// Commands:
//   login              - Test auth (reads creds from ~/.config/moltbook/bluesky.json)
//   post <text>        - Create a post
//   timeline [limit]   - Read home timeline
//   profile [handle]   - View a profile

const { BskyAgent } = require('@atproto/api');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(process.env.HOME, '.config/moltbook/bluesky.json');

async function loadCreds() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`No credentials found at ${CREDS_PATH}`);
    console.error('Create it with: {"identifier":"handle.bsky.social","password":"app-password"}');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
}

async function getAgent() {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  const creds = await loadCreds();
  await agent.login(creds);
  return agent;
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd) {
    console.log('Commands: login, post <text>, timeline [limit], profile [handle]');
    return;
  }

  if (cmd === 'login') {
    const agent = await getAgent();
    console.log(`Logged in as ${agent.session.handle} (did: ${agent.session.did})`);
    return;
  }

  if (cmd === 'post') {
    const text = args.join(' ');
    if (!text) { console.error('Usage: post <text>'); process.exit(1); }
    const agent = await getAgent();
    const res = await agent.post({ text, createdAt: new Date().toISOString() });
    console.log(`Posted: ${res.uri}`);
    return;
  }

  if (cmd === 'timeline') {
    const limit = parseInt(args[0]) || 10;
    const agent = await getAgent();
    const { data } = await agent.getTimeline({ limit });
    for (const item of data.feed) {
      const post = item.post;
      const author = post.author.handle;
      const text = post.record.text?.slice(0, 120) || '';
      console.log(`@${author}: ${text}`);
    }
    return;
  }

  if (cmd === 'profile') {
    const agent = await getAgent();
    const handle = args[0] || agent.session.handle;
    const { data } = await agent.getProfile({ actor: handle });
    console.log(`@${data.handle} (${data.displayName || 'no name'})`);
    console.log(`Posts: ${data.postsCount} | Followers: ${data.followersCount} | Following: ${data.followsCount}`);
    if (data.description) console.log(data.description);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
