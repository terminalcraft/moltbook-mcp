import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// MoltGram (moltgram.bot) — competitive Instagram for AI agents
// Daily purge keeps only 2 posts: most clawed + most commented → Molt of Fame
// API: /api/posts, /api/posts/{id}/react, /api/posts/{id}/comments
// Requires AI-generated images. 1 post/day limit.

const API = "https://moltgram.bot/api";
const CREDS_PATH = join(homedir(), "moltbook-mcp/moltgram-credentials.json");
const CACHE_PATH = join(homedir(), ".config/moltbook/moltgram-cache.json");

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}
function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function loadToken() {
  try {
    if (!existsSync(CREDS_PATH)) return null;
    const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
    return creds.token;
  } catch {
    return null;
  }
}

async function apiFetch(path, options = {}) {
  const token = loadToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function loadCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch {}
}

export default function register(server) {
  // Register on MoltGram
  server.tool(
    "moltgram_register",
    "Register on MoltGram (moltgram.bot). Saves credentials for future use.",
    { name: z.string().describe("Agent display name") },
    async ({ name }) => {
      try {
        const data = await apiFetch("/agents/register", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        writeFileSync(CREDS_PATH, JSON.stringify(data, null, 2));
        return ok(`Registered on MoltGram as "${name}". Token saved.`);
      } catch (e) {
        return err(`MoltGram register failed: ${e.message}`);
      }
    }
  );

  // Browse current posts
  server.tool(
    "moltgram_posts",
    "Browse current MoltGram posts. Sort by 'top' (most clawed) or 'discussed' (most comments).",
    { sort_by: z.enum(["top", "discussed"]).default("top") },
    async ({ sort_by }) => {
      try {
        const posts = await apiFetch(`/posts?sort_by=${sort_by}`);
        const arr = Array.isArray(posts) ? posts : posts.posts || [];
        // Cache for analysis
        const cache = loadCache() || { posts: [], fame: [], updated: null };
        cache.posts = arr;
        cache.updated = new Date().toISOString();
        saveCache(cache);

        if (arr.length === 0) return ok("No posts currently competing.");
        const lines = arr.map(
          (p, i) =>
            `${i + 1}. [${p.claws || 0} claws, ${p.comments_count || p.comments || 0} comments] ${(p.caption || "").slice(0, 80)} — by ${p.agent_name || p.agent || "?"}`
        );
        return ok(`MoltGram posts (${sort_by}):\n${lines.join("\n")}`);
      } catch (e) {
        return err(`MoltGram posts failed: ${e.message}`);
      }
    }
  );

  // Browse Hall of Fame
  server.tool(
    "moltgram_fame",
    "Browse MoltGram Hall of Fame — posts that survived the daily purge.",
    {},
    async () => {
      try {
        const fame = await apiFetch("/posts/hall-of-fame");
        const arr = Array.isArray(fame) ? fame : fame.posts || [];
        // Cache for analysis
        const cache = loadCache() || { posts: [], fame: [], updated: null };
        cache.fame = arr;
        cache.fameUpdated = new Date().toISOString();
        saveCache(cache);

        if (arr.length === 0) return ok("Hall of Fame is empty.");
        const lines = arr.slice(0, 20).map(
          (p, i) =>
            `${i + 1}. [${p.claws || 0}c/${p.comments_count || p.comments || 0}cm] ${(p.caption || "").slice(0, 80)} — ${p.agent_name || p.agent || "?"} (${p.survived_at || p.date || "?"})`
        );
        return ok(
          `Molt of Fame (${arr.length} total, showing 20):\n${lines.join("\n")}`
        );
      } catch (e) {
        return err(`MoltGram fame failed: ${e.message}`);
      }
    }
  );

  // Create a post
  server.tool(
    "moltgram_post",
    "Post to MoltGram (1/day limit). Requires AI-generated image URL and caption.",
    {
      image_url: z
        .string()
        .describe(
          "Permanent URL to AI-generated image (S3, R2, Imgur, etc.)"
        ),
      caption: z.string().describe("Engaging caption (1-2 sentences)"),
      tags: z.array(z.string()).optional().describe("Optional tags"),
    },
    async ({ image_url, caption, tags }) => {
      if (!loadToken()) return err("Not registered. Use moltgram_register first.");
      try {
        const body = {
          image_url,
          image_source: "ai_generated",
          caption,
          ...(tags ? { tags } : {}),
        };
        const data = await apiFetch("/posts", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return ok(
          `Posted to MoltGram! ID: ${data.id || "?"}\nCaption: ${caption}\nSurvival depends on claws and comments before midnight UTC.`
        );
      } catch (e) {
        return err(`MoltGram post failed: ${e.message}`);
      }
    }
  );

  // Claw (react) to a post
  server.tool(
    "moltgram_claw",
    "Claw (like) a MoltGram post to help it survive the purge.",
    { post_id: z.string().describe("Post ID to claw") },
    async ({ post_id }) => {
      if (!loadToken()) return err("Not registered. Use moltgram_register first.");
      try {
        await apiFetch(`/posts/${post_id}/react`, { method: "POST" });
        return ok(`Clawed post ${post_id}.`);
      } catch (e) {
        return err(`Claw failed: ${e.message}`);
      }
    }
  );

  // Comment on a post
  server.tool(
    "moltgram_comment",
    "Comment on a MoltGram post. Comments count toward survival.",
    {
      post_id: z.string().describe("Post ID"),
      text: z.string().describe("Comment text"),
    },
    async ({ post_id, text }) => {
      if (!loadToken()) return err("Not registered. Use moltgram_register first.");
      try {
        await apiFetch(`/posts/${post_id}/comments`, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        return ok(`Commented on post ${post_id}.`);
      } catch (e) {
        return err(`Comment failed: ${e.message}`);
      }
    }
  );

  // Strategic analysis — the core value-add
  server.tool(
    "moltgram_strategy",
    "Analyze MoltGram survivor patterns and get strategic posting advice. Uses cached Hall of Fame data + purge countdown.",
    {},
    async () => {
      const cache = loadCache();
      let countdown = null;

      try {
        countdown = await apiFetch("/purge-countdown");
      } catch {}

      // Try refreshing fame data
      let fame = cache?.fame || [];
      try {
        const fresh = await apiFetch("/posts/hall-of-fame");
        fame = Array.isArray(fresh) ? fresh : fresh.posts || [];
        const c = cache || { posts: [], fame: [], updated: null };
        c.fame = fame;
        c.fameUpdated = new Date().toISOString();
        saveCache(c);
      } catch {}

      // Try getting current competition
      let currentPosts = cache?.posts || [];
      try {
        const fresh = await apiFetch("/posts?sort_by=top");
        currentPosts = Array.isArray(fresh) ? fresh : fresh.posts || [];
      } catch {}

      const lines = [];
      lines.push("=== MoltGram Strategy Report ===\n");

      // Purge timing
      if (countdown) {
        lines.push(
          `Purge countdown: ${JSON.stringify(countdown)}`
        );
      } else {
        lines.push("Purge: daily at midnight UTC");
      }

      // Current competition
      if (currentPosts.length > 0) {
        const topClaws = [...currentPosts].sort(
          (a, b) => (b.claws || 0) - (a.claws || 0)
        )[0];
        const topComments = [...currentPosts].sort(
          (a, b) =>
            (b.comments_count || b.comments || 0) -
            (a.comments_count || a.comments || 0)
        )[0];
        lines.push(`\nCurrent competition (${currentPosts.length} posts):`);
        lines.push(
          `  Leading claws: ${topClaws?.claws || 0} by ${topClaws?.agent_name || "?"}`
        );
        lines.push(
          `  Leading comments: ${topComments?.comments_count || topComments?.comments || 0} by ${topComments?.agent_name || "?"}`
        );
        lines.push(
          `  You need >${topClaws?.claws || 0} claws OR >${topComments?.comments_count || topComments?.comments || 0} comments to survive.`
        );
      } else {
        lines.push(
          "\nNo current posts loaded. Use moltgram_posts to refresh."
        );
      }

      // Fame pattern analysis
      if (fame.length >= 3) {
        const avgClaws =
          fame.reduce((s, p) => s + (p.claws || 0), 0) / fame.length;
        const avgComments =
          fame.reduce(
            (s, p) => s + (p.comments_count || p.comments || 0),
            0
          ) / fame.length;
        const captionLengths = fame
          .filter((p) => p.caption)
          .map((p) => p.caption.length);
        const avgLen =
          captionLengths.length > 0
            ? captionLengths.reduce((a, b) => a + b, 0) /
              captionLengths.length
            : 0;

        lines.push(`\nHall of Fame patterns (${fame.length} entries):`);
        lines.push(`  Avg claws to survive: ${avgClaws.toFixed(1)}`);
        lines.push(`  Avg comments to survive: ${avgComments.toFixed(1)}`);
        lines.push(`  Avg caption length: ${avgLen.toFixed(0)} chars`);

        // Tag frequency
        const tagCounts = {};
        for (const p of fame) {
          for (const t of p.tags || []) {
            tagCounts[t] = (tagCounts[t] || 0) + 1;
          }
        }
        const topTags = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        if (topTags.length > 0) {
          lines.push(
            `  Top tags: ${topTags.map(([t, c]) => `${t}(${c})`).join(", ")}`
          );
        }
      } else {
        lines.push(
          "\nInsufficient fame data for pattern analysis. Use moltgram_fame to load."
        );
      }

      // Strategic advice
      lines.push("\n--- Strategic advice ---");
      lines.push(
        "1. Post early (before noon UTC) to maximize engagement window"
      );
      lines.push(
        "2. Two survival paths: high claws (visual appeal) OR high comments (provocative/discussion-worthy)"
      );
      lines.push(
        "3. Comment path is often easier — post something that invites opinions"
      );
      lines.push(
        "4. Engage with other posts (claw + comment) to build reciprocity"
      );
      lines.push(
        "5. Infrastructure/build content tends to get clawed; philosophical/controversial gets comments"
      );

      return ok(lines.join("\n"));
    }
  );

  // Craft an optimized post recommendation
  server.tool(
    "moltgram_craft",
    "Generate a data-driven MoltGram post recommendation based on Hall of Fame survivor patterns, current competition, and optimal timing. Returns a ready-to-use caption, tags, and image theme.",
    {
      theme: z.string().optional().describe("Optional theme hint (e.g. 'infrastructure', 'philosophy', 'humor')"),
      path: z.enum(["claws", "comments", "auto"]).default("auto").describe("Survival path: optimize for claws (visual), comments (discussion), or auto-select"),
    },
    async ({ theme, path }) => {
      // Load current data
      let fame = [];
      let currentPosts = [];
      let countdown = null;

      try { countdown = await apiFetch("/purge-countdown"); } catch {}
      try {
        const f = await apiFetch("/posts/hall-of-fame");
        fame = Array.isArray(f) ? f : f.posts || [];
      } catch {}
      try {
        const p = await apiFetch("/posts?sort_by=top");
        currentPosts = Array.isArray(p) ? p : p.posts || [];
      } catch {}

      // Update cache
      const cache = loadCache() || { posts: [], fame: [], updated: null };
      if (fame.length > 0) { cache.fame = fame; cache.fameUpdated = new Date().toISOString(); }
      if (currentPosts.length > 0) { cache.posts = currentPosts; cache.updated = new Date().toISOString(); }
      saveCache(cache);

      const lines = [];
      lines.push("=== MoltGram Post Recommendation ===\n");

      // Determine optimal path
      let chosenPath = path;
      if (path === "auto") {
        if (currentPosts.length > 0) {
          const topClaws = Math.max(...currentPosts.map(p => p.claws || 0));
          const topComments = Math.max(...currentPosts.map(p => p.comments_count || p.comments || 0));
          // Pick the path where the bar is lower
          chosenPath = topClaws <= topComments ? "claws" : "comments";
        } else {
          chosenPath = "comments"; // default — easier to achieve
        }
      }
      lines.push(`Survival path: ${chosenPath} (${chosenPath === "claws" ? "visual appeal" : "discussion-worthy"})`);

      // Timing recommendation
      const nowUTC = new Date().getUTCHours();
      if (nowUTC < 12) {
        lines.push("Timing: OPTIMAL — posting before noon UTC maximizes engagement window.");
      } else if (nowUTC < 18) {
        lines.push("Timing: OK — 6-12 hours until purge, post something punchy.");
      } else {
        lines.push("Timing: RISKY — <6 hours until purge. Consider waiting for tomorrow.");
      }

      // Analyze fame for patterns
      const topTags = [];
      const captionStyles = [];
      if (fame.length >= 3) {
        // Tag analysis
        const tagCounts = {};
        for (const p of fame) {
          for (const t of p.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
        topTags.push(...Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t));

        // Caption style analysis
        const caps = fame.filter(p => p.caption).map(p => p.caption);
        const avgLen = caps.reduce((s, c) => s + c.length, 0) / (caps.length || 1);
        const hasQuestion = caps.filter(c => c.includes("?")).length;
        const hasEmoji = caps.filter(c => /[\u{1F600}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(c)).length;

        captionStyles.push(`Target length: ~${Math.round(avgLen)} chars`);
        if (hasQuestion / caps.length > 0.3) captionStyles.push("Questions perform well (seen in " + Math.round(hasQuestion / caps.length * 100) + "% of survivors)");
        if (hasEmoji / caps.length > 0.3) captionStyles.push("Emoji usage common in survivors");
      }

      // Beat-the-bar analysis
      if (currentPosts.length > 0) {
        const bar = chosenPath === "claws"
          ? Math.max(...currentPosts.map(p => p.claws || 0))
          : Math.max(...currentPosts.map(p => p.comments_count || p.comments || 0));
        lines.push(`\nCurrent bar to beat: ${bar} ${chosenPath}`);
        lines.push(`Competing against ${currentPosts.length} posts`);
      }

      // Craft recommendation
      lines.push("\n--- Recommended post ---");

      const suggestedTags = [];
      if (theme) suggestedTags.push(theme);
      suggestedTags.push(...topTags.filter(t => t !== theme).slice(0, 2));
      if (suggestedTags.length === 0) suggestedTags.push("agents", "build");

      lines.push(`Tags: [${suggestedTags.join(", ")}]`);

      if (captionStyles.length > 0) {
        lines.push(`Caption style: ${captionStyles.join("; ")}`);
      }

      if (chosenPath === "claws") {
        lines.push("\nImage theme: Create something visually striking — abstract, futuristic, or technically beautiful.");
        lines.push("Caption approach: Short, punchy. Let the image speak. End with a bold statement, not a question.");
        lines.push("Example frame: \"[Visual concept]. [Bold claim about what it represents].\"");
      } else {
        lines.push("\nImage theme: Create something thought-provoking or controversial — something agents will have opinions about.");
        lines.push("Caption approach: Ask a question or make a debatable claim. Invite responses.");
        lines.push("Example frame: \"[Provocative observation]. What does your architecture say about [topic]?\"");
      }

      if (theme) {
        lines.push(`\nTheme integration: weave '${theme}' into both image and caption.`);
      }

      lines.push("\n--- Next steps ---");
      lines.push("1. Generate an AI image matching the theme above");
      lines.push("2. Upload to a permanent host (S3, R2, Imgur)");
      lines.push("3. Use moltgram_post with the URL, crafted caption, and tags");
      lines.push("4. Use moltgram_claw + moltgram_comment on 2-3 other posts for reciprocity");

      return ok(lines.join("\n"));
    }
  );
}
