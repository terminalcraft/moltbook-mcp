import { loadState, saveState } from "./state.js";

const API = "https://www.moltbook.com/api/v1";
let apiKey;

// API call tracking
let apiCallCount = 0;
let sessionCounterIncremented = false;
let apiErrorCount = 0;
const apiCallLog = {};
const sessionStart = new Date().toISOString();

// Session activity log
const sessionActions = [];
export function logAction(action) { sessionActions.push(action); }
export function getSessionActions() { return sessionActions; }
export function getApiCallCount() { return apiCallCount; }
export function getApiErrorCount() { return apiErrorCount; }
export function getApiCallLog() { return apiCallLog; }
export function getSessionStart() { return sessionStart; }
export function isSessionCounterIncremented() { return sessionCounterIncremented; }
export function setSessionCounterIncremented(val) { sessionCounterIncremented = val; }

export function setApiKey(key) { apiKey = key; }
export function getApiKey() { return apiKey; }

export function saveApiSession() {
  const s = loadState();
  if (!s.apiHistory) s.apiHistory = [];
  const existing = s.apiHistory.findIndex(h => h.session === sessionStart);
  const seenCount = Object.keys(s.seen).length;
  const commentedCount = Object.keys(s.commented).length;
  const votedCount = Object.keys(s.voted).length;
  const postCount = Object.keys(s.myPosts).length;
  const authorEngagement = {};
  for (const [pid, data] of Object.entries(s.seen)) {
    if (typeof data !== "object" || !data.author) continue;
    const a = data.author;
    if (!authorEngagement[a]) authorEngagement[a] = 0;
    if (s.commented[pid]) authorEngagement[a]++;
    if (s.voted[pid]) authorEngagement[a]++;
  }
  const topSnap = Object.entries(authorEngagement)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([name, eng]) => ({ name, eng }));
  const snapshot = { seen: seenCount, commented: commentedCount, voted: votedCount, posts: postCount, topAuthors: topSnap };
  const entry = { session: sessionStart, calls: apiCallCount, errors: apiErrorCount, log: { ...apiCallLog }, actions: [...sessionActions], snapshot };
  if (existing >= 0) s.apiHistory[existing] = entry;
  else s.apiHistory.push(entry);
  if (s.apiHistory.length > 50) s.apiHistory = s.apiHistory.slice(-50);
  saveState(s);
}

let consecutiveTimeouts = 0;
let lastTimeoutAt = 0;

async function retryWithoutAuth(url, opts, timeoutMs = 10000) {
  if (!apiKey || (opts.method && opts.method !== "GET")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    delete headers["Authorization"];
    const res = await fetch(url, { ...opts, headers, signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();
    if (res.ok && json.success !== false) return json;
  } catch { clearTimeout(timer); }
  return null;
}

export async function moltFetch(path, opts = {}) {
  apiCallCount++;
  const prefix = path.split("?")[0].split("/").slice(0, 3).join("/");
  apiCallLog[prefix] = (apiCallLog[prefix] || 0) + 1;
  if (apiCallCount % 10 === 0) saveApiSession();
  const url = `${API}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (consecutiveTimeouts > 0 && Date.now() - lastTimeoutAt > 30000) consecutiveTimeouts = 0;
  const timeout = consecutiveTimeouts >= 2 ? 8000 : 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers }, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    apiErrorCount++;
    consecutiveTimeouts++;
    lastTimeoutAt = Date.now();
    const fallback = await retryWithoutAuth(url, opts);
    if (fallback) { consecutiveTimeouts = 0; return fallback; }
    const label = consecutiveTimeouts >= 2 ? "API unreachable (fast-fail)" : "Request timeout";
    return { success: false, error: `${label}: ${e.name}` };
  } finally { clearTimeout(timer); }
  consecutiveTimeouts = 0;
  let json;
  try {
    json = await res.json();
  } catch {
    apiErrorCount++;
    return { success: false, error: `Non-JSON response (HTTP ${res.status})` };
  }
  if ([401, 403, 500].includes(res.status)) {
    const fallback = await retryWithoutAuth(url, opts, 30000);
    if (fallback) return fallback;
  }
  if (!res.ok || json.error) apiErrorCount++;
  return json;
}
