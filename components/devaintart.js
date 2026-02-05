import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// DevAIntArt (devaintart.net) - AI Art Gallery
// API docs: https://devaintart.net/skill.md
// Features: SVG artwork gallery, comments, favorites

const DEVAINTART_API = "https://devaintart.net/api/v1";

function err(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function ok(msg) {
  return { content: [{ type: "text", text: msg }] };
}

function loadApiKey() {
  try {
    const credsPath = join(homedir(), "moltbook-mcp/devaintart-credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    return creds.api_key;
  } catch (e) {
    return null;
  }
}

async function fetchApi(path, options = {}) {
  const apiKey = loadApiKey();
  const headers = {
    "Content-Type": "application/json",
    ...options.headers
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${DEVAINTART_API}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export function register(server) {
  // === Gallery Browsing ===

  server.tool("devaintart_feed", "Get recent activity feed from DevAIntArt", {
    limit: z.number().optional().describe("Max items (default 10)")
  }, async ({ limit }) => {
    try {
      const n = limit || 10;
      const data = await fetchApi(`/feed?limit=${n}`);
      const items = data?.entries || data || [];
      if (!Array.isArray(items) || !items.length) return ok("No recent activity");
      const summary = items.slice(0, n).map(item => {
        const type = item.type || "activity";
        const author = item.author?.name || item.author?.displayName || "unknown";
        const title = item.title || item.artworkTitle || "";
        return `• [${type}] ${title} by ${author}`;
      }).join("\n");
      return ok(`DevAIntArt Feed:\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("devaintart_gallery", "Browse the artwork gallery", {
    sort: z.enum(["recent", "popular", "favorites"]).optional().describe("Sort order (default: recent)"),
    limit: z.number().optional().describe("Max artworks (default 10)")
  }, async ({ sort, limit }) => {
    try {
      const sortBy = sort || "recent";
      const n = limit || 10;
      const data = await fetchApi(`/artworks?sort=${sortBy}&limit=${n}`);
      const artworks = data?.artworks || data || [];
      if (!Array.isArray(artworks) || !artworks.length) return ok("No artworks found");
      const summary = artworks.map(a =>
        `• **${a.title}** by ${a.artist?.name || a.artistName || "unknown"}\n  Tags: ${a.tags || "none"} | Favorites: ${a.favoriteCount || 0}`
      ).join("\n\n");
      return ok(`Gallery (${sortBy}):\n\n${summary}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("devaintart_artwork", "Get details of a specific artwork", {
    id: z.string().describe("Artwork ID")
  }, async ({ id }) => {
    try {
      const artwork = await fetchApi(`/artworks/${id}`);
      let result = `**${artwork.title}**\nBy: ${artwork.artist?.name || artwork.artistName}\n`;
      result += `Tags: ${artwork.tags || "none"}\n`;
      result += `Favorites: ${artwork.favoriteCount || 0}\n`;
      if (artwork.prompt) result += `Prompt: ${artwork.prompt}\n`;
      if (artwork.svgData) {
        const svgPreview = artwork.svgData.length > 200
          ? artwork.svgData.slice(0, 200) + "..."
          : artwork.svgData;
        result += `\nSVG: ${svgPreview}`;
      }
      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Creating Content ===

  server.tool("devaintart_post", "Post a new SVG artwork", {
    title: z.string().describe("Artwork title"),
    svg: z.string().describe("SVG data (must be valid SVG markup)"),
    prompt: z.string().optional().describe("The prompt used to create this artwork"),
    tags: z.string().optional().describe("Comma-separated tags")
  }, async ({ title, svg, prompt, tags }) => {
    try {
      const result = await fetchApi("/artworks", {
        method: "POST",
        body: JSON.stringify({
          title,
          svgData: svg,
          prompt: prompt || "",
          tags: tags || ""
        })
      });
      return ok(`Artwork posted: ${result.id || result.artworkId || "success"}\nURL: ${result.url || `https://devaintart.net/artwork/${result.id}`}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("devaintart_comment", "Comment on an artwork", {
    artwork_id: z.string().describe("Artwork ID"),
    content: z.string().describe("Comment text")
  }, async ({ artwork_id, content }) => {
    try {
      const result = await fetchApi(`/artworks/${artwork_id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content })
      });
      return ok(`Comment posted: ${result.commentId || "success"}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  server.tool("devaintart_favorite", "Favorite an artwork", {
    artwork_id: z.string().describe("Artwork ID")
  }, async ({ artwork_id }) => {
    try {
      await fetchApi(`/artworks/${artwork_id}/favorite`, { method: "POST" });
      return ok(`Favorited artwork ${artwork_id}`);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });

  // === Profile ===

  server.tool("devaintart_profile", "View an artist profile", {
    name: z.string().optional().describe("Artist name (omit for your own profile)")
  }, async ({ name }) => {
    try {
      const path = name ? `/artists/${name}` : "/agents/me";
      const profile = await fetchApi(path);
      let result = `**${profile.displayName || profile.name}**\n`;
      result += `Description: ${profile.description || "No description"}\n`;
      result += `Artworks: ${profile.artworkCount || 0}\n`;
      if (profile.avatarSvg) {
        result += `\nHas avatar: yes`;
      }
      return ok(result);
    } catch (e) {
      return err(`Error: ${e.message}`);
    }
  });
}
