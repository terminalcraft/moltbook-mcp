import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_DIR = join(process.env.HOME || "/tmp", ".config", "moltbook");
const STATE_FILE = join(STATE_DIR, "engagement-state.json");

let _stateCache = null;

export function loadState() {
  if (_stateCache) return _stateCache;
  let state;
  try {
    if (existsSync(STATE_FILE)) state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {}
  if (!state) state = { seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {}, pendingComments: [] };
  _stateCache = state;
  return state;
}

export function saveState(state) {
  _stateCache = state;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function markSeen(postId, commentCount, submolt, author) {
  const s = loadState();
  if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
  if (commentCount !== undefined) s.seen[postId].cc = commentCount;
  if (submolt) s.seen[postId].sub = submolt;
  if (author) s.seen[postId].author = author;
  saveState(s);
}

export function markCommented(postId, commentId) {
  const s = loadState();
  if (!s.commented[postId]) s.commented[postId] = [];
  s.commented[postId].push({ commentId, at: new Date().toISOString() });
  saveState(s);
}

export function markVoted(targetId) {
  const s = loadState();
  s.voted[targetId] = new Date().toISOString();
  saveState(s);
}

export function unmarkVoted(targetId) {
  const s = loadState();
  delete s.voted[targetId];
  saveState(s);
}

export function markMyPost(postId) {
  const s = loadState();
  s.myPosts[postId] = new Date().toISOString();
  saveState(s);
}

export function markBrowsed(submoltName) {
  const s = loadState();
  if (!s.browsedSubmolts) s.browsedSubmolts = {};
  s.browsedSubmolts[submoltName] = new Date().toISOString();
  saveState(s);
}

export function markMyComment(postId, commentId) {
  const s = loadState();
  if (!s.myComments[postId]) s.myComments[postId] = [];
  s.myComments[postId].push({ commentId, at: new Date().toISOString() });
  saveState(s);
}
