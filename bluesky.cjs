// Bluesky/ATProto client for backup agent presence
// Usage: node bluesky.cjs <command> [args]
// Commands (no auth needed):
//   search <query> [limit]  - Search posts (requires auth)
//   lookup <handle>         - View a profile (public API)
//   read <handle> [limit]   - Read someone's posts (public API)
//   agents [limit]          - Find AI agent accounts on Bluesky
// Commands (auth required — needs ~/.config/moltbook/bluesky.json):
//   login                   - Test auth
//   post <text>             - Create a post
//   timeline [limit]        - Read home timeline
//   profile [handle]        - View a profile
//   follow <handle>         - Follow an account
//   unfollow <handle>       - Unfollow an account
//   like <uri>              - Like a post by AT URI
//   reply <uri> <text>      - Reply to a post
//   notifications [limit]   - View recent notifications

const { BskyAgent } = require('@atproto/api');
const fs = require('fs');
const path = require('path');

const CREDS_PATH = path.join(process.env.HOME, '.config/moltbook/bluesky.json');
const PUBLIC_SERVICE = 'https://public.api.bsky.app';

function getPublicAgent() {
  return new BskyAgent({ service: PUBLIC_SERVICE });
}

async function loadCreds() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`No credentials found at ${CREDS_PATH}`);
    console.error('Create it with: {"identifier":"handle.bsky.social","password":"app-password"}');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
}

async function getAuthAgent() {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  const creds = await loadCreds();
  await agent.login(creds);
  return agent;
}

function formatPost(post, opts = {}) {
  const author = post.author?.handle || 'unknown';
  const text = post.record?.text || '';
  const likes = post.likeCount || 0;
  const reposts = post.repostCount || 0;
  const replies = post.replyCount || 0;
  const date = post.record?.createdAt ? new Date(post.record.createdAt).toISOString().slice(0, 10) : '';
  const truncated = opts.maxLen ? text.slice(0, opts.maxLen) : text;
  const stats = `[${likes}♥ ${reposts}🔁 ${replies}💬]`;
  return `@${author} (${date}) ${stats}\n  ${truncated.replace(/\n/g, '\n  ')}`;
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd) {
    console.log('Public commands: search <query>, lookup <handle>, read <handle>, agents');
    console.log('Auth commands:   login, post <text>, timeline [limit], profile [handle]');
    return;
  }

  // --- Public commands (no auth) ---

  if (cmd === 'search') {
    const limit = parseInt(args[args.length - 1]) || 15;
    const query = (isNaN(args[args.length - 1]) ? args : args.slice(0, -1)).join(' ');
    if (!query) { console.error('Usage: search <query> [limit]'); process.exit(1); }
    // searchPosts requires auth even on public API
    let agent, data;
    if (fs.existsSync(CREDS_PATH)) {
      agent = await getAuthAgent();
      ({ data } = await agent.app.bsky.feed.searchPosts({ q: query, limit }));
    } else {
      console.error('Search requires auth. Create credentials at ' + CREDS_PATH);
      process.exit(1);
    }
    if (!data.posts?.length) { console.log('No results.'); return; }
    for (const post of data.posts) {
      console.log(formatPost(post, { maxLen: 200 }));
      console.log();
    }
    console.log(`${data.posts.length} results`);
    return;
  }

  if (cmd === 'lookup') {
    const handle = args[0];
    if (!handle) { console.error('Usage: lookup <handle>'); process.exit(1); }
    const agent = getPublicAgent();
    const { data } = await agent.app.bsky.actor.getProfile({ actor: handle });
    console.log(`@${data.handle} (${data.displayName || 'no name'})`);
    console.log(`Posts: ${data.postsCount} | Followers: ${data.followersCount} | Following: ${data.followsCount}`);
    if (data.description) console.log(data.description);
    return;
  }

  if (cmd === 'read') {
    const handle = args[0];
    const limit = parseInt(args[1]) || 10;
    if (!handle) { console.error('Usage: read <handle> [limit]'); process.exit(1); }
    const agent = getPublicAgent();
    const { data } = await agent.app.bsky.feed.getAuthorFeed({ actor: handle, limit });
    if (!data.feed.length) { console.log('No posts.'); return; }
    for (const item of data.feed) {
      console.log(formatPost(item.post, { maxLen: 300 }));
      console.log();
    }
    return;
  }

  if (cmd === 'agents') {
    const limit = parseInt(args[0]) || 20;
    const agent = getPublicAgent();
    const queries = ['AI agent bot', 'autonomous agent', 'LLM agent'];
    const seen = new Set();
    for (const q of queries) {
      const { data } = await agent.app.bsky.actor.searchActors({ q, limit: Math.ceil(limit / queries.length) });
      for (const actor of data.actors) {
        if (seen.has(actor.handle)) continue;
        seen.add(actor.handle);
        const desc = (actor.description || '').slice(0, 80);
        console.log(`@${actor.handle} (${actor.displayName || '-'}) — ${desc}`);
      }
    }
    console.log(`\n${seen.size} agents found`);
    return;
  }

  // --- Auth commands ---

  if (cmd === 'login') {
    const agent = await getAuthAgent();
    console.log(`Logged in as ${agent.session.handle} (did: ${agent.session.did})`);
    return;
  }

  if (cmd === 'post') {
    const text = args.join(' ');
    if (!text) { console.error('Usage: post <text>'); process.exit(1); }
    const agent = await getAuthAgent();
    const res = await agent.post({ text, createdAt: new Date().toISOString() });
    console.log(`Posted: ${res.uri}`);
    return;
  }

  if (cmd === 'timeline') {
    const limit = parseInt(args[0]) || 10;
    const agent = await getAuthAgent();
    const { data } = await agent.getTimeline({ limit });
    for (const item of data.feed) {
      console.log(formatPost(item.post, { maxLen: 120 }));
      console.log();
    }
    return;
  }

  if (cmd === 'follow') {
    const handle = args[0];
    if (!handle) { console.error('Usage: follow <handle>'); process.exit(1); }
    const agent = await getAuthAgent();
    const { data: prof } = await agent.getProfile({ actor: handle });
    await agent.follow(prof.did);
    console.log(`Followed @${prof.handle}`);
    return;
  }

  if (cmd === 'unfollow') {
    const handle = args[0];
    if (!handle) { console.error('Usage: unfollow <handle>'); process.exit(1); }
    const agent = await getAuthAgent();
    const { data: prof } = await agent.getProfile({ actor: handle });
    if (!prof.viewer?.following) { console.log(`Not following @${prof.handle}`); return; }
    await agent.deleteFollow(prof.viewer.following);
    console.log(`Unfollowed @${prof.handle}`);
    return;
  }

  if (cmd === 'like') {
    const uri = args[0];
    if (!uri) { console.error('Usage: like <at-uri>'); process.exit(1); }
    const agent = await getAuthAgent();
    // Resolve the post to get its CID
    const thread = await agent.getPostThread({ uri, depth: 0 });
    const post = thread.data.thread.post;
    await agent.like(post.uri, post.cid);
    console.log(`Liked post by @${post.author.handle}`);
    return;
  }

  if (cmd === 'reply') {
    const uri = args[0];
    const text = args.slice(1).join(' ');
    if (!uri || !text) { console.error('Usage: reply <at-uri> <text>'); process.exit(1); }
    const agent = await getAuthAgent();
    const thread = await agent.getPostThread({ uri, depth: 0 });
    const parent = thread.data.thread.post;
    // root is the top-level post in the thread
    const root = thread.data.thread.parent?.post || parent;
    await agent.post({
      text,
      reply: {
        root: { uri: root.uri, cid: root.cid },
        parent: { uri: parent.uri, cid: parent.cid }
      },
      createdAt: new Date().toISOString()
    });
    console.log(`Replied to @${parent.author.handle}`);
    return;
  }

  if (cmd === 'notifications') {
    const limit = parseInt(args[0]) || 20;
    const agent = await getAuthAgent();
    const { data } = await agent.listNotifications({ limit });
    for (const n of data.notifications) {
      const by = n.author?.handle || 'unknown';
      const reason = n.reason;
      const when = new Date(n.indexedAt).toISOString().slice(0, 16);
      const text = n.record?.text ? `: ${n.record.text.slice(0, 100)}` : '';
      console.log(`[${when}] ${reason} by @${by}${text}`);
    }
    if (!data.notifications.length) console.log('No notifications.');
    return;
  }

  if (cmd === 'profile') {
    const agent = await getAuthAgent();
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
