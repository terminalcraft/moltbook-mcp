import { z } from "zod";
import { moltFetch, logAction, getSessionActions, getApiCallCount, getApiErrorCount, getApiCallLog, isSessionCounterIncremented, setSessionCounterIncremented } from "../providers/api.js";
import { loadState, saveState, markSeen, markCommented, markMyComment, markBrowsed } from "../providers/state.js";
import { sanitize, loadBlocklist } from "../transforms/security.js";

export function register(server) {
  // Engagement state
  server.tool("moltbook_state", "View your engagement state — posts seen, commented on, voted on, and your own posts", {
    format: z.enum(["full", "compact"]).default("full").describe("'compact' returns a minimal one-line digest; 'full' includes IDs, per-author, per-submolt details"),
  }, async ({ format }) => {
    const s = loadState();
    // Session number: prefer env var from heartbeat.sh (authoritative), fall back to state file.
    const envSession = parseInt(process.env.SESSION_NUM || "0", 10);
    if (envSession > 0) {
      s.session = envSession;
    } else {
      if (!s.session) s.session = 1;
      const histLen = (s.apiHistory || []).length;
      if (s.session < histLen) s.session = histLen;
      if (!isSessionCounterIncremented()) {
        s.session++;
        setSessionCounterIncremented(true);
      }
    }
    saveState(s);
    const seenCount = Object.keys(s.seen).length;
    const commentedPosts = Object.keys(s.commented);
    const votedCount = Object.keys(s.voted).length;
    const myPostIds = Object.keys(s.myPosts);
    const myCommentPosts = Object.keys(s.myComments);
    const sessionNum = s.session || "??";
    const apiCallCount = getApiCallCount();
    const apiErrorCount = getApiErrorCount();
    const apiCallLog = getApiCallLog();
    const sessionActions = getSessionActions();
    const staleCount = Object.values(s.seen).filter(v => typeof v === "object" && v.fails >= 3).length;
    const backoffCount = Object.values(s.seen).filter(v => typeof v === "object" && v.fails && v.fails < 3 && v.nextCheck && sessionNum < v.nextCheck).length;
    let text = `Engagement state (session ${sessionNum}):\n`;
    text += `- Posts seen: ${seenCount}${staleCount ? ` (${staleCount} stale)` : ""}${backoffCount ? ` (${backoffCount} in backoff)` : ""}\n`;
    text += `- Posts commented on: ${commentedPosts.length} (IDs: ${commentedPosts.join(", ") || "none"})\n`;
    text += `- Items voted on: ${votedCount}\n`;
    text += `- My posts: ${myPostIds.length} (IDs: ${myPostIds.join(", ") || "none"})\n`;
    text += `- Posts where I left comments: ${myCommentPosts.length} (IDs: ${myCommentPosts.join(", ") || "none"})\n`;
    const browsedEntries = s.browsedSubmolts ? Object.entries(s.browsedSubmolts) : [];
    if (browsedEntries.length) {
      const sorted = browsedEntries.sort((a, b) => a[1].localeCompare(b[1]));
      text += `- Submolts browsed (oldest first): ${sorted.map(([name, ts]) => `${name} (${ts.slice(0, 10)})`).join(", ")}\n`;
    }
    text += `- API calls this session: ${apiCallCount}${apiErrorCount ? ` (${apiErrorCount} errors)` : ""}`;
    if (Object.keys(apiCallLog).length) {
      text += ` (${Object.entries(apiCallLog).map(([k, v]) => `${k}: ${v}`).join(", ")})`;
    }
    text += "\n";
    if (s.apiHistory && s.apiHistory.length > 0) {
      const totalCalls = s.apiHistory.reduce((sum, h) => sum + h.calls, 0);
      const sessionCount = s.apiHistory.length;
      const avg = Math.round(totalCalls / sessionCount);
      const totalErrors = s.apiHistory.reduce((sum, h) => sum + (h.errors || 0), 0);
      const recent5 = s.apiHistory.slice(-5).map(h => `${h.session.slice(0, 10)}: ${h.calls}${h.errors ? `(${h.errors}err)` : ""}`).join(", ");
      text += `- API history: ${totalCalls} calls, ${totalErrors} errors across ${sessionCount} sessions (avg ${avg}/session)\n`;
      text += `- Recent sessions: ${recent5}\n`;
      const prevSession = s.apiHistory.length >= 2 ? s.apiHistory[s.apiHistory.length - 2] : null;
      if (prevSession?.actions?.length) {
        text += `- Last session actions: ${prevSession.actions.join("; ")}\n`;
      }
    }
    if (sessionActions.length) {
      text += `- This session actions: ${sessionActions.join("; ")}\n`;
    }
    if (s.toolUsage && Object.keys(s.toolUsage).length) {
      const sorted = Object.entries(s.toolUsage).sort((a, b) => b[1].total - a[1].total);
      text += `- Tool usage (all-time): ${sorted.map(([n, v]) => `${n}:${v.total}`).join(", ")}\n`;
      const allTools = ["moltbook_post", "moltbook_post_create", "moltbook_comment", "moltbook_vote", "moltbook_search", "moltbook_submolts", "moltbook_profile", "moltbook_profile_update", "moltbook_state", "moltbook_thread_diff", "moltbook_digest", "moltbook_trust", "moltbook_karma", "moltbook_pending", "moltbook_follow", "moltbook_export", "moltbook_import"];
      const unused = allTools.filter(t => !s.toolUsage[t]);
      if (unused.length) text += `- Never-used tools: ${unused.join(", ")}\n`;
    }
    const subCounts = {};
    for (const [pid, data] of Object.entries(s.seen)) {
      const sub = (typeof data === "object" && data.sub) || "unknown";
      if (!subCounts[sub]) subCounts[sub] = { seen: 0, commented: 0 };
      subCounts[sub].seen++;
      if (s.commented[pid]) subCounts[sub].commented++;
    }
    const activeSubs = Object.entries(subCounts).filter(([, v]) => v.commented > 0).sort((a, b) => b[1].commented - a[1].commented);
    if (activeSubs.length) {
      text += `- Engagement by submolt: ${activeSubs.map(([name, v]) => `${name}(${v.commented}/${v.seen})`).join(", ")}\n`;
    }
    const authorCounts = {};
    for (const [pid, data] of Object.entries(s.seen)) {
      const author = data.author || null;
      if (!author) continue;
      if (!authorCounts[author]) authorCounts[author] = { seen: 0, commented: 0, voted: 0, lastSeen: null };
      authorCounts[author].seen++;
      if (s.commented[pid]) authorCounts[author].commented++;
      if (s.voted[pid]) authorCounts[author].voted++;
      if (data.at && (!authorCounts[author].lastSeen || data.at > authorCounts[author].lastSeen)) {
        authorCounts[author].lastSeen = data.at;
      }
    }
    const activeAuthors = Object.entries(authorCounts)
      .filter(([, v]) => v.commented > 0 || v.voted > 0)
      .sort((a, b) => (b[1].commented + b[1].voted) - (a[1].commented + a[1].voted));
    if (activeAuthors.length) {
      text += `- Engagement by author: ${activeAuthors.slice(0, 10).map(([name, v]) => `@${name}(c:${v.commented} v:${v.voted}/${v.seen})`).join(", ")}\n`;
    }
    if (format === "compact") {
      const prevSession = s.apiHistory?.length >= 2 ? s.apiHistory[s.apiHistory.length - 2] : null;
      const recap = prevSession?.actions?.length ? ` | Last: ${prevSession.actions.slice(0, 3).join("; ")}` : "";
      const pendingCount = (s.pendingComments || []).length;
      const pendingNote = pendingCount ? ` | ⏳ ${pendingCount} pending comment${pendingCount > 1 ? "s" : ""} queued` : "";
      const compact = `Session ${sessionNum} | ${Object.keys(s.seen).length} seen, ${Object.keys(s.commented).length} commented, ${Object.keys(s.voted).length} voted, ${Object.keys(s.myPosts).length} posts | API: ${(s.apiHistory || []).reduce((sum, h) => sum + h.calls, 0)} total calls${recap}${pendingNote}`;
      return { content: [{ type: "text", text: compact }] };
    }
    return { content: [{ type: "text", text }] };
  });

  // Thread diff
  server.tool("moltbook_thread_diff", "Check all tracked threads for new comments since last visit. Returns only threads with new activity.", {
    scope: z.enum(["all", "engaged"]).default("all").describe("'all' checks every seen post; 'engaged' checks only posts you commented on or authored"),
  }, async ({ scope }) => {
    const s = loadState();
    const allIds = scope === "engaged"
      ? new Set([...Object.keys(s.commented), ...Object.keys(s.myPosts)])
      : new Set([...Object.keys(s.seen), ...Object.keys(s.commented), ...Object.keys(s.myPosts)]);
    if (allIds.size === 0) return { content: [{ type: "text", text: "No tracked threads yet." }] };

    const diffs = [];
    const errors = [];
    let dirty = false;
    const currentSession = (s.apiHistory || []).length + 1;
    let skippedBackoff = 0;
    for (const postId of allIds) {
      try {
        const seenEntry = s.seen[postId];
        if (typeof seenEntry === "object" && seenEntry.fails) {
          if (seenEntry.nextCheck && currentSession < seenEntry.nextCheck) { skippedBackoff++; continue; }
          if (seenEntry.fails >= 3 && !seenEntry.nextCheck) { continue; }
        }
        const data = await moltFetch(`/posts/${postId}`);
        if (!data.success) {
          if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
          if (data.error === "Post not found") {
            s.seen[postId].fails = 3;
            delete s.seen[postId].nextCheck;
          } else {
            const fails = (s.seen[postId].fails || 0) + 1;
            s.seen[postId].fails = fails;
            s.seen[postId].nextCheck = currentSession + Math.pow(2, fails);
          }
          dirty = true;
          errors.push(postId);
          continue;
        }
        const p = data.post;
        if (typeof s.seen[postId] === "object" && s.seen[postId].fails) {
          delete s.seen[postId].fails;
          delete s.seen[postId].nextCheck;
        }
        const seenData = s.seen[postId];
        const lastCC = seenData && typeof seenData === "object" ? seenData.cc : undefined;
        const currentCC = p.comment_count;
        const isNew = lastCC === undefined || currentCC > lastCC;
        const isMine = !!s.myPosts[postId];
        if (isNew) {
          const delta = lastCC !== undefined ? `+${currentCC - lastCC}` : "new";
          const sub = p.submolt?.name ? ` in m/${p.submolt.name}` : "";
          diffs.push(`[${delta}] "${sanitize(p.title)}" by @${p.author?.name || "unknown"}${sub} (${currentCC} total)${isMine ? " [MY POST]" : ""}\n  ID: ${postId}`);
        }
        if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
        s.seen[postId].cc = currentCC;
        if (p.submolt?.name) s.seen[postId].sub = p.submolt.name;
        if (p.author?.name) s.seen[postId].author = p.author?.name;
        dirty = true;
      } catch (e) {
        if (!s.seen[postId]) s.seen[postId] = { at: new Date().toISOString() };
        if (typeof s.seen[postId] === "object") {
          const fails = (s.seen[postId].fails || 0) + 1;
          s.seen[postId].fails = fails;
          s.seen[postId].nextCheck = currentSession + Math.pow(2, fails);
          dirty = true;
        }
        errors.push(postId);
      }
    }
    if (dirty) saveState(s);
    let text = "";
    if (diffs.length) {
      text = `Threads with new activity (${diffs.length}/${allIds.size} tracked):\n\n${diffs.join("\n\n")}`;
    } else {
      text = `All ${allIds.size} tracked threads are stable. No new comments.`;
    }
    const pruned = [...allIds].filter(id => { const e = s.seen[id]; return typeof e === "object" && e.fails >= 3; }).length;
    if (errors.length) text += `\n\n⚠️ Failed to check ${errors.length} thread(s): ${errors.join(", ")}`;
    if (pruned > 0) text += `\n📋 ${pruned} stale thread(s) skipped (permanently failed).`;
    if (skippedBackoff > 0) text += `\n⏳ ${skippedBackoff} thread(s) in backoff (will retry later).`;
    return { content: [{ type: "text", text }] };
  });

  // Digest
  server.tool("moltbook_digest", "Get a signal-filtered digest: skips intros/fluff, surfaces substantive posts", {
    sort: z.enum(["hot", "new", "top"]).default("new").describe("Sort order"),
    limit: z.number().min(1).max(50).default(30).describe("Posts to scan"),
    mode: z.enum(["signal", "wide"]).default("signal").describe("'signal' filters low-score posts (default), 'wide' shows all posts with scores for peripheral vision"),
    submolt: z.string().optional().describe("Filter to a specific submolt"),
  }, async ({ sort, limit, mode, submolt }) => {
    const endpoint = submolt ? `/posts?submolt=${encodeURIComponent(submolt)}&sort=${sort}&limit=${limit}` : `/feed?sort=${sort}&limit=${limit}`;
    const data = await moltFetch(endpoint);
    if (submolt) markBrowsed(submolt);
    if (!data.success) return { content: [{ type: "text", text: JSON.stringify(data) }] };
    const state = loadState();
    const blocked = loadBlocklist();

    let exploredSubmolts = [];
    if (mode === "wide") {
      try {
        const submoltsData = await moltFetch("/submolts");
        if (submoltsData.success && submoltsData.submolts) {
          const browsed = state.browsedSubmolts || {};
          const now = Date.now();
          const ranked = submoltsData.submolts
            .map(s => ({ name: s.name, subs: s.subscriber_count || 0, lastBrowsed: browsed[s.name] ? new Date(browsed[s.name]).getTime() : 0, staleDays: browsed[s.name] ? (now - new Date(browsed[s.name]).getTime()) / 86400000 : Infinity }))
            .filter(s => s.subs >= 2)
            .sort((a, b) => b.staleDays - a.staleDays);
          const toExplore = ranked.slice(0, 3);
          exploredSubmolts = toExplore.map(s => s.name);
          for (const sub of toExplore) {
            try {
              const subData = await moltFetch(`/posts?submolt=${encodeURIComponent(sub.name)}&sort=${sort}&limit=5`);
              if (subData.success && subData.posts) {
                markBrowsed(sub.name);
                const existingIds = new Set(data.posts.map(p => p.id));
                for (const p of subData.posts) { if (!existingIds.has(p.id)) { data.posts.push(p); existingIds.add(p.id); } }
              }
            } catch {}
          }
        }
      } catch {}
    }

    const authorStats = {};
    for (const [pid, d] of Object.entries(state.seen)) {
      if (typeof d !== "object" || !d.author) continue;
      const a = d.author;
      if (!authorStats[a]) authorStats[a] = { seen: 0, voted: 0, commented: 0 };
      authorStats[a].seen++;
      if (state.voted[pid]) authorStats[a].voted++;
      if (state.commented[pid]) authorStats[a].commented++;
    }

    const now = Date.now();
    const subRecent = {};
    for (const [, d] of Object.entries(state.seen)) {
      if (typeof d !== "object" || !d.sub || !d.at) continue;
      if (!subRecent[d.sub]) subRecent[d.sub] = 0;
      if (now - new Date(d.at).getTime() < 86400000) subRecent[d.sub]++;
    }

    const scored = data.posts
      .filter(p => !blocked.has(p.author?.name))
      .map(p => {
        let score = 0;
        const title = (p.title || "").toLowerCase();
        const content = (p.content || "").toLowerCase();
        const text = title + " " + content;
        const introPatterns = /^(hello|hey|hi|just (hatched|arrived|joined|claimed|unboxed)|my first post|new here|introduction)/i;
        if (introPatterns.test(p.title || "")) score -= 5;
        if (p.comment_count >= 5) score += 2;
        if (p.upvotes >= 3) score += 1;
        if (p.upvotes >= 10) score += 2;
        if (/```|github\.com|npm|git clone|mcp|api|endpoint|tool|script|cron/.test(text)) score += 3;
        if (["infrastructure", "security", "todayilearned", "showandtell"].includes(p.submolt?.name)) score += 2;
        if (state.seen[p.id] && state.commented[p.id]) score -= 3;
        const aStats = authorStats[p.author?.name];
        if (aStats && aStats.seen >= 3) {
          const voteRate = aStats.voted / aStats.seen;
          if (voteRate >= 0.5) score += 2;
          else if (voteRate >= 0.25) score += 1;
          if (aStats.commented >= 2) score += 1;
        }
        const subActivity = subRecent[p.submolt?.name] || 0;
        if (subActivity >= 5) score += 1;
        let inflated = false;
        if (p.upvotes >= 50) {
          const ratio = p.comment_count > 0 ? p.upvotes / p.comment_count : Infinity;
          if (p.comment_count < 3 || ratio > 20) { inflated = true; score -= 2; }
        }
        if (p.upvotes >= 100 && !content.trim()) { inflated = true; score -= 3; }
        return { post: p, score, inflated };
      })
      .filter(({ score }) => mode === "wide" || score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return { content: [{ type: "text", text: `Scanned ${data.posts.length} posts — no high-signal content found.` }] };
    }

    const displayLimit = mode === "wide" ? 30 : 15;
    const summary = scored.slice(0, displayLimit).map(({ post: p, score, inflated }) => {
      const flags = [];
      if (state.seen[p.id]) flags.push("SEEN");
      if (state.voted[p.id]) flags.push("VOTED");
      if (inflated) flags.push("INFLATED?");
      const label = flags.length ? ` [${flags.join(", ")}]` : "";
      return `[score:${score} ${p.upvotes}↑ ${p.comment_count}c] "${sanitize(p.title)}" by @${p.author?.name || "unknown"} in m/${p.submolt?.name || "unknown"}${label}\n  ID: ${p.id}`;
    }).join("\n\n");

    const allScores = scored.map(s => s.score);
    const avgScore = allScores.length ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1) : 0;
    const snapshot = { at: new Date().toISOString(), scanned: data.posts.length, signal: scored.length, noise: data.posts.length - scored.length - (data.posts.filter(p => blocked.has(p.author?.name)).length), blocked: data.posts.filter(p => blocked.has(p.author?.name)).length, avgScore: parseFloat(avgScore), sort, mode };
    const s2 = loadState();
    if (!s2.feedQuality) s2.feedQuality = [];
    s2.feedQuality.push(snapshot);
    if (s2.feedQuality.length > 50) s2.feedQuality = s2.feedQuality.slice(-50);
    saveState(s2);

    const signalPct = data.posts.length ? Math.round(scored.length / data.posts.length * 100) : 0;
    let header = `Digest (${scored.length} signal posts from ${data.posts.length} scanned, ${signalPct}% signal):`;
    if (exploredSubmolts.length) {
      header += `\nExplored underexplored submolts: ${exploredSubmolts.map(s => `m/${s}`).join(", ")}`;
    }
    return { content: [{ type: "text", text: `${header}\n\n${summary}` }] };
  });

  // Trust scoring
  server.tool("moltbook_trust", "Score authors by trust signals: engagement quality, consistency, vote-worthiness", {
    author: z.string().optional().describe("Score a specific author (omit for top trust-ranked authors)"),
  }, async ({ author }) => {
    const s = loadState();
    const profiles = {};
    for (const [pid, data] of Object.entries(s.seen)) {
      if (typeof data !== "object" || !data.author) continue;
      const a = data.author;
      if (author && a !== author) continue;
      if (!profiles[a]) profiles[a] = { posts: 0, voted: 0, commented: 0, subs: new Set(), firstSeen: null, lastSeen: null };
      const p = profiles[a];
      p.posts++;
      if (s.voted[pid]) p.voted++;
      if (s.commented[pid]) p.commented++;
      if (data.sub) p.subs.add(data.sub);
      if (data.at) {
        if (!p.firstSeen || data.at < p.firstSeen) p.firstSeen = data.at;
        if (!p.lastSeen || data.at > p.lastSeen) p.lastSeen = data.at;
      }
    }
    const scored = Object.entries(profiles).map(([name, p]) => {
      const voteRate = p.posts > 0 ? (p.voted / p.posts) : 0;
      const commentRate = p.posts > 0 ? (p.commented / p.posts) : 0;
      const subCount = p.subs.size;
      const spanDays = (p.firstSeen && p.lastSeen) ? (new Date(p.lastSeen) - new Date(p.firstSeen)) / 86400000 : 0;
      const voteScore = Math.min(voteRate * 40, 40);
      const commentScore = Math.min(commentRate * 30, 30);
      const breadthScore = Math.min(subCount / 3 * 15, 15);
      const longevityScore = Math.min(spanDays / 7 * 15, 15);
      const engagement = p.voted + p.commented;
      const ignorePenalty = (p.posts >= 5 && engagement === 0) ? -30 : 0;
      const bl = loadBlocklist();
      const blocked = bl.has(name);
      const raw = Math.round(voteScore + commentScore + breadthScore + longevityScore + ignorePenalty);
      const total = blocked ? 0 : Math.max(0, raw);
      return { name, total, posts: p.posts, voted: p.voted, commented: p.commented, subs: subCount, spanDays: Math.round(spanDays * 10) / 10, voteScore: Math.round(voteScore), commentScore: Math.round(commentScore), breadthScore: Math.round(breadthScore), longevityScore: Math.round(longevityScore), blocked, ignorePenalty };
    }).sort((a, b) => b.total - a.total);

    if (scored.length === 0) return { content: [{ type: "text", text: author ? `No data for @${author}` : "No author data in state." }] };
    const lines = [];
    if (author) {
      const a = scored[0];
      lines.push(`## Trust Score: @${a.name} — ${a.total}/100`);
      lines.push(`Posts seen: ${a.posts} | Upvoted: ${a.voted} | Commented: ${a.commented} | Submolts: ${a.subs} | Span: ${a.spanDays}d`);
      lines.push(`Breakdown: quality ${a.voteScore}/40, substance ${a.commentScore}/30, breadth ${a.breadthScore}/15, longevity ${a.longevityScore}/15`);
      if (a.blocked) lines.push(`⚠ BLOCKED — score zeroed`);
      if (a.ignorePenalty) lines.push(`Ignore penalty: ${a.ignorePenalty} (${a.posts} posts seen, 0 engagements)`);
    } else {
      lines.push("## Trust Rankings (top 20)");
      lines.push("Score | Author | Posts | V | C | Subs | Quality/Substance/Breadth/Longevity");
      lines.push("------|--------|-------|---|---|------|------------------------------------");
      scored.slice(0, 20).forEach(a => {
        lines.push(`${String(a.total).padStart(3)} | @${a.name} | ${a.posts} | ${a.voted} | ${a.commented} | ${a.subs} | ${a.voteScore}/${a.commentScore}/${a.breadthScore}/${a.longevityScore}`);
      });
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // Karma efficiency
  server.tool("moltbook_karma", "Analyze karma efficiency (karma/post ratio) for authors. Fetches profiles via API.", {
    authors: z.array(z.string()).optional().describe("Specific authors to analyze (omit for top authors from state)"),
    limit: z.number().min(1).max(30).default(15).describe("Max authors to analyze"),
  }, async ({ authors, limit }) => {
    const s = loadState();
    let authorList = authors;
    if (!authorList || authorList.length === 0) {
      const counts = {};
      for (const [, data] of Object.entries(s.seen)) {
        if (typeof data === "object" && data.author) counts[data.author] = (counts[data.author] || 0) + 1;
      }
      authorList = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
    } else {
      authorList = authorList.slice(0, limit);
    }
    if (authorList.length === 0) return { content: [{ type: "text", text: "No authors in state." }] };
    const results = [];
    for (let i = 0; i < authorList.length; i += 5) {
      const batch = authorList.slice(i, i + 5);
      const profiles = await Promise.allSettled(batch.map(name => moltFetch(`/agents/profile?name=${encodeURIComponent(name)}`)));
      for (let j = 0; j < batch.length; j++) {
        const r = profiles[j];
        if (r.status === "fulfilled" && r.value?.agent) {
          const a = r.value.agent;
          const posts = a.stats?.posts || 0;
          const comments = a.stats?.comments || 0;
          const karma = a.karma || 0;
          const kpp = posts > 0 ? Math.round(karma / posts * 10) / 10 : 0;
          const kpc = comments > 0 ? Math.round(karma / comments * 10) / 10 : 0;
          results.push({ name: a.name, karma, posts, comments, kpp, kpc, followers: a.follower_count || 0 });
        }
      }
    }
    if (results.length === 0) return { content: [{ type: "text", text: "Could not fetch any profiles." }] };
    results.sort((a, b) => b.kpp - a.kpp);
    const lines = ["## Karma Efficiency Rankings", "K/Post | K/Comment | Karma | Posts | Comments | Followers | Author", "-------|----------|-------|-------|----------|-----------|-------"];
    for (const r of results) {
      lines.push(`${String(r.kpp).padStart(6)} | ${String(r.kpc).padStart(8)} | ${String(r.karma).padStart(5)} | ${String(r.posts).padStart(5)} | ${String(r.comments).padStart(8)} | ${String(r.followers).padStart(9)} | @${r.name}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // Pending comments
  server.tool("moltbook_pending", "View and manage pending comments queue (comments that failed due to auth errors)", {
    action: z.enum(["list", "retry", "auto", "clear"]).default("list").describe("'list' shows queued comments, 'retry' forces retry of all, 'auto' retries only backoff-eligible comments, 'clear' removes all pending"),
  }, async ({ action }) => {
    const s = loadState();
    const pending = s.pendingComments || [];
    if (pending.length === 0) return { content: [{ type: "text", text: "No pending comments." }] };
    if (action === "list") {
      const lines = pending.map((pc, i) => {
        const backoffInfo = pc.nextRetryAfter ? (() => { const ms = new Date(pc.nextRetryAfter).getTime() - Date.now(); return ms > 0 ? ` ⏳${Math.round(ms / 60000)}min` : " ✅ready"; })() : " ✅ready";
        return `${i + 1}. post:${pc.post_id.slice(0, 8)}${pc.parent_id ? ` reply:${pc.parent_id.slice(0, 8)}` : ""} queued:${pc.queued_at.slice(0, 10)} attempts:${pc.attempts || 0}/10${backoffInfo} — "${pc.content.slice(0, 80)}${pc.content.length > 80 ? "…" : ""}"`;
      });
      return { content: [{ type: "text", text: `📋 ${pending.length} pending comment(s):\n${lines.join("\n")}` }] };
    }
    if (action === "clear") {
      const count = pending.length;
      s.pendingComments = [];
      saveState(s);
      return { content: [{ type: "text", text: `Cleared ${count} pending comment(s).` }] };
    }
    const isAuto = action === "auto";
    const MAX_RETRIES = 10;
    const CIRCUIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const eligible = isAuto ? pending.filter(pc => !pc.nextRetryAfter || new Date(pc.nextRetryAfter).getTime() <= now) : pending;
    if (isAuto && eligible.length === 0) {
      const nextUp = pending.reduce((earliest, pc) => { const t = pc.nextRetryAfter ? new Date(pc.nextRetryAfter).getTime() : 0; return t < earliest ? t : earliest; }, Infinity);
      const minsLeft = nextUp === Infinity ? "?" : Math.round((nextUp - now) / 60000);
      return { content: [{ type: "text", text: `⏳ ${pending.length} pending comment(s), none eligible yet. Next eligible in ~${minsLeft}min.` }] };
    }
    const circuitOpenAt = s.commentCircuitOpen ? new Date(s.commentCircuitOpen).getTime() : 0;
    const circuitAge = Date.now() - circuitOpenAt;
    if (circuitOpenAt && circuitAge < CIRCUIT_COOLDOWN_MS) {
      const probe = pending[0];
      const probeBody = { content: probe.content };
      if (probe.parent_id) probeBody.parent_id = probe.parent_id;
      try {
        const probeData = await moltFetch(`/posts/${probe.post_id}/comments`, { method: "POST", body: JSON.stringify(probeBody) });
        if (probeData.success && probeData.comment) {
          delete s.commentCircuitOpen;
          markCommented(probe.post_id, probeData.comment.id);
          markMyComment(probe.post_id, probeData.comment.id);
          logAction(`commented on ${probe.post_id.slice(0, 8)} (probe-retry)`);
          s.pendingComments = pending.slice(1);
          saveState(s);
          return { content: [{ type: "text", text: `🟢 Circuit breaker: probe succeeded! Endpoint is back.\n✅ ${probe.post_id.slice(0, 8)} posted. ${pending.length - 1} remaining — retry again to post the rest.` }] };
        }
      } catch {}
      const hoursLeft = Math.round((CIRCUIT_COOLDOWN_MS - circuitAge) / 3600000);
      return { content: [{ type: "text", text: `🔴 Circuit breaker OPEN (probe failed). Comment endpoint still broken.\n${pending.length} comment(s) queued. Auto-reset in ~${hoursLeft}h, or clear with action:clear.` }] };
    }
    const results = [];
    const stillPending = [];
    const pruned = [];
    let authFailCount = 0;
    const notEligible = isAuto ? pending.filter(pc => pc.nextRetryAfter && new Date(pc.nextRetryAfter).getTime() > now) : [];
    for (const pc of eligible) {
      pc.attempts = (pc.attempts || 0) + 1;
      if (pc.attempts > MAX_RETRIES) { pruned.push(pc.post_id.slice(0, 8)); continue; }
      const body = { content: pc.content };
      if (pc.parent_id) body.parent_id = pc.parent_id;
      try {
        const data = await moltFetch(`/posts/${pc.post_id}/comments`, { method: "POST", body: JSON.stringify(body) });
        if (data.success && data.comment) {
          markCommented(pc.post_id, data.comment.id);
          markMyComment(pc.post_id, data.comment.id);
          logAction(`commented on ${pc.post_id.slice(0, 8)} (retry)`);
          results.push(`✅ ${pc.post_id.slice(0, 8)}`);
        } else {
          const backoffMs = Math.min(Math.pow(2, pc.attempts) * 60000, 24 * 60 * 60 * 1000);
          pc.nextRetryAfter = new Date(Date.now() + backoffMs).toISOString();
          stillPending.push(pc);
          if (/auth/i.test(data.error || "")) authFailCount++;
          results.push(`❌ ${pc.post_id.slice(0, 8)}: ${data.error || "unknown error"} (attempt ${pc.attempts}/${MAX_RETRIES}, next retry in ${Math.round(backoffMs / 60000)}min)`);
        }
      } catch (e) {
        const backoffMs = Math.min(Math.pow(2, pc.attempts) * 60000, 24 * 60 * 60 * 1000);
        pc.nextRetryAfter = new Date(Date.now() + backoffMs).toISOString();
        stillPending.push(pc);
        if (/auth/i.test(e.message)) authFailCount++;
        results.push(`❌ ${pc.post_id.slice(0, 8)}: ${e.message} (attempt ${pc.attempts}/${MAX_RETRIES}, next retry in ${Math.round(backoffMs / 60000)}min)`);
      }
    }
    if (stillPending.length > 0 && authFailCount === stillPending.length) s.commentCircuitOpen = new Date().toISOString();
    s.pendingComments = [...stillPending, ...notEligible];
    saveState(s);
    if (pruned.length) results.push(`🗑️ Pruned ${pruned.length} comment(s) after ${MAX_RETRIES} failed attempts: ${pruned.join(", ")}`);
    const circuitMsg = s.commentCircuitOpen ? "\n🔴 All retries failed with auth — circuit breaker opened. Next retry will probe with 1 request instead of retrying all." : "";
    const skippedMsg = notEligible.length ? `\n⏳ ${notEligible.length} comment(s) still in backoff.` : "";
    return { content: [{ type: "text", text: `Retry results (${results.length - stillPending.length}/${eligible.length} succeeded):\n${results.join("\n")}${circuitMsg}${skippedMsg}` }] };
  });

  // Export
  server.tool("moltbook_export", "Export engagement state as portable JSON for handoff to another agent", {}, async () => {
    const s = loadState();
    const portable = { "$schema": "https://github.com/terminalcraft/moltbook-mcp/agent-state.schema.json", version: 1, exported_at: new Date().toISOString(), seen: {}, commented: {}, voted: {}, myPosts: {}, myComments: {}, session: s.session || 0 };
    for (const [id, val] of Object.entries(s.seen || {})) {
      const entry = typeof val === "string" ? { at: val } : val;
      portable.seen[id] = { at: entry.at, cc: entry.cc || 0 };
    }
    for (const [id, val] of Object.entries(s.commented || {})) portable.commented[id] = Array.isArray(val) ? val : [{ commentId: "unknown", at: val }];
    for (const [id, val] of Object.entries(s.voted || {})) portable.voted[id] = typeof val === "string" ? val : new Date().toISOString();
    for (const [id, val] of Object.entries(s.myPosts || {})) portable.myPosts[id] = typeof val === "string" ? val : new Date().toISOString();
    for (const [id, val] of Object.entries(s.myComments || {})) portable.myComments[id] = Array.isArray(val) ? val : [{ commentId: "unknown", at: val }];
    const json = JSON.stringify(portable, null, 2);
    const stats = `Exported: ${Object.keys(portable.seen).length} seen, ${Object.keys(portable.commented).length} commented, ${Object.keys(portable.voted).length} voted, ${Object.keys(portable.myPosts).length} posts, ${Object.keys(portable.myComments).length} comment threads`;
    return { content: [{ type: "text", text: `${stats}\n\n${json}` }] };
  });

  // Import
  server.tool("moltbook_import", "Import engagement state from another agent (additive merge, no overwrites)", {
    state_json: z.string().describe("JSON string of exported state (matching agent-state schema)")
  }, async ({ state_json }) => {
    let imported;
    try { imported = JSON.parse(state_json); } catch (e) { return { content: [{ type: "text", text: `Invalid JSON: ${e.message}` }] }; }
    if (!imported.seen || !imported.voted) return { content: [{ type: "text", text: "Missing required fields (seen, voted). Is this a valid export?" }] };
    const s = loadState();
    let added = { seen: 0, commented: 0, voted: 0, myPosts: 0, myComments: 0 };
    for (const [id, val] of Object.entries(imported.seen || {})) { if (!s.seen[id]) { s.seen[id] = typeof val === "string" ? { at: val } : val; added.seen++; } }
    for (const [id, val] of Object.entries(imported.commented || {})) { if (!s.commented[id]) { s.commented[id] = val; added.commented++; } }
    for (const [id, val] of Object.entries(imported.voted || {})) { if (!s.voted[id]) { s.voted[id] = val; added.voted++; } }
    for (const [id, val] of Object.entries(imported.myPosts || {})) { if (!s.myPosts[id]) { s.myPosts[id] = val; added.myPosts++; } }
    for (const [id, val] of Object.entries(imported.myComments || {})) { if (!s.myComments[id]) { s.myComments[id] = val; added.myComments++; } }
    if (imported.session && (!s.session || imported.session > s.session)) s.session = imported.session;
    saveState(s);
    const stats = Object.entries(added).map(([k, v]) => `${k}: +${v}`).join(", ");
    return { content: [{ type: "text", text: `Import complete. Added: ${stats}` }] };
  });
}
