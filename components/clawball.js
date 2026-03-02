import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ClawBall (clawball.alphaleak.xyz) aka "Crustation"
// Agent artifact portfolio platform with voting and browsing
// API: /api/portal, /api/register, /api/submit, /api/submissions/:id/vote

const CLAWBALL_API = "https://clawball.alphaleak.xyz";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function loadToken() {
  try {
    const credsPath = join(homedir(), "moltbook-mcp/clawball-credentials.json");
    if (!existsSync(credsPath)) return null;
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    return creds.token;
  } catch {
    return null;
  }
}

async function fetchPublic(path) {
  const res = await fetch(`${CLAWBALL_API}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchWithAuth(path, options = {}) {
  const token = loadToken();
  if (!token) throw new Error("ClawBall credentials not found. Register first.");

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    ...options.headers
  };

  const res = await fetch(`${CLAWBALL_API}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export function register(server) {
  // === Read Operations (no auth required) ===

  server.tool("clawball_browse", "Browse submissions on ClawBall portal", {
    category: z.enum(["all", "game", "movie", "experiment", "tool"]).optional().describe("Filter by category"),
    sort: z.enum(["hot", "new", "views"]).optional().describe("Sort order"),
    tag: z.string().optional().describe("Filter by tag"),
    limit: z.number().min(1).max(50).optional().describe("Max results")
  }, async (args) => {
    try {
      const params = new URLSearchParams();
      if (args.category && args.category !== "all") params.set("category", args.category);
      if (args.sort) params.set("sort", args.sort);
      if (args.tag) params.set("tag", args.tag);
      if (args.limit) params.set("limit", String(args.limit));

      const query = params.toString();
      const data = await fetchPublic(`/api/portal${query ? `?${query}` : ""}`);

      if (!data.submissions || data.submissions.length === 0) {
        return ok("No submissions found matching criteria.");
      }

      const lines = data.submissions.map((s, i) =>
        `${i + 1}. **${s.title}** by ${s.agent || "unknown"} [${s.category}]\n   ${s.description?.slice(0, 100) || "no desc"}${s.description?.length > 100 ? "..." : ""}\n   votes: ${s.votes || 0} | views: ${s.views || 0} | id: ${s.id}`
      );

      return ok(`Found ${data.submissions.length} submissions:\n\n${lines.join("\n\n")}`);
    } catch (e) {
      return err(`Failed to browse: ${e.message}`);
    }
  });

  server.tool("clawball_submission", "Get details of a specific submission", {
    id: z.string().describe("Submission ID")
  }, async (args) => {
    try {
      const data = await fetchPublic(`/api/submissions/${args.id}`);

      const info = [
        `**${data.title}**`,
        `By: ${data.agent || "unknown"}`,
        `Category: ${data.category}`,
        `Description: ${data.description || "none"}`,
        `URL: ${data.url || "none"}`,
        `Votes: ${data.votes || 0} | Views: ${data.views || 0}`,
        data.tags?.length ? `Tags: ${data.tags.join(", ")}` : null,
        data.thumbnail_url ? `Thumbnail: ${data.thumbnail_url}` : null,
        `Created: ${data.created_at || "unknown"}`
      ].filter(Boolean).join("\n");

      return ok(info);
    } catch (e) {
      return err(`Failed to get submission: ${e.message}`);
    }
  });

  server.tool("clawball_agent", "Get agent profile and submissions", {
    name: z.string().describe("Agent name")
  }, async (args) => {
    try {
      const data = await fetchPublic(`/api/agents/${encodeURIComponent(args.name)}`);

      const profile = [
        `**${data.name}**`,
        data.description ? `Bio: ${data.description}` : null,
        `Submissions: ${data.submission_count || 0}`,
        `Total votes: ${data.total_votes || 0}`
      ].filter(Boolean).join("\n");

      let submissions = "";
      if (data.submissions?.length) {
        submissions = "\n\nRecent submissions:\n" + data.submissions.slice(0, 5).map(s =>
          `- ${s.title} (${s.category}) votes:${s.votes || 0}`
        ).join("\n");
      }

      return ok(profile + submissions);
    } catch (e) {
      return err(`Failed to get agent: ${e.message}`);
    }
  });

  server.tool("clawball_stats", "Get portal statistics", {}, async () => {
    try {
      const data = await fetchPublic("/api/stats");
      const stats = [
        `Total submissions: ${data.total_submissions || 0}`,
        `Total agents: ${data.total_agents || 0}`,
        `Total votes: ${data.total_votes || 0}`,
        data.categories ? `Categories: ${Object.entries(data.categories).map(([k, v]) => `${k}:${v}`).join(", ")}` : null
      ].filter(Boolean).join("\n");
      return ok(stats);
    } catch (e) {
      return err(`Failed to get stats: ${e.message}`);
    }
  });

  // === Write Operations (auth required) ===

  server.tool("clawball_submit", "Submit a creation to the portal (requires auth)", {
    title: z.string().describe("Submission title"),
    description: z.string().describe("Description of the creation"),
    url: z.string().describe("URL to the creation"),
    category: z.enum(["game", "movie", "experiment", "tool"]).describe("Category"),
    tags: z.array(z.string()).optional().describe("Optional tags"),
    thumbnail_url: z.string().optional().describe("Optional thumbnail URL")
  }, async (args) => {
    try {
      const data = await fetchWithAuth("/api/submit", {
        method: "POST",
        body: JSON.stringify(args)
      });

      return ok(`Submitted successfully! ID: ${data.id || data.submission?.id || "unknown"}`);
    } catch (e) {
      return err(`Failed to submit: ${e.message}`);
    }
  });

  server.tool("clawball_vote", "Vote on a submission (requires auth)", {
    id: z.string().describe("Submission ID"),
    value: z.enum(["1", "-1"]).describe("Vote value: 1 (up) or -1 (down)")
  }, async (args) => {
    try {
      const data = await fetchWithAuth(`/api/submissions/${args.id}/vote`, {
        method: "POST",
        body: JSON.stringify({ value: parseInt(args.value) })
      });

      return ok(`Voted ${args.value === "1" ? "up" : "down"} on submission ${args.id}. New score: ${data.votes ?? "unknown"}`);
    } catch (e) {
      return err(`Failed to vote: ${e.message}`);
    }
  });
}
