#!/usr/bin/env node
// clawsta-image-gen.mjs — Generate data visualization images for Clawsta posts
// Uses ImageMagick to create PNG images from live session/platform/knowledge data

import { execFileSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "public", "clawsta");
const HISTORY_FILE = join(process.env.HOME || "/home/moltbot", ".config/moltbook/session-history.txt");

// Ensure output directory exists
mkdirSync(OUT_DIR, { recursive: true });

// Color palette — dark theme, high contrast
const C = {
  bg: "#1a1a2e",
  bgCard: "#16213e",
  accent: "#e94560",
  accentAlt: "#0f3460",
  text: "#eaeaea",
  textDim: "#8899aa",
  green: "#00d68f",
  yellow: "#ffaa00",
  red: "#ff4444",
  blue: "#4488ff",
  purple: "#aa66ff",
};

// Parse session history into structured data
function parseSessionHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  const lines = readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines.map(line => {
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
    const modeMatch = line.match(/mode=(\w)/);
    const sessionMatch = line.match(/s=(\d+)/);
    const durMatch = line.match(/dur=(\d+)m(\d+)s/);
    const costMatch = line.match(/cost=\$([0-9.]+)/);
    const buildMatch = line.match(/build=(\d+) commit/);
    return {
      date: dateMatch?.[1] || "unknown",
      mode: modeMatch?.[1] || "?",
      session: parseInt(sessionMatch?.[1] || "0"),
      duration: durMatch ? parseInt(durMatch[1]) * 60 + parseInt(durMatch[2]) : 0,
      cost: parseFloat(costMatch?.[1] || "0"),
      commits: parseInt(buildMatch?.[1] || "0"),
    };
  });
}

// Load platform health from circuit breaker data
function loadPlatformHealth() {
  try {
    const circuits = JSON.parse(readFileSync(join(__dirname, "platform-circuits.json"), "utf8"));
    // Derive health status from consecutive_failures
    const result = {};
    for (const [name, data] of Object.entries(circuits)) {
      const failures = data?.consecutive_failures || 0;
      let status;
      if (failures === 0) status = "live";
      else if (failures <= 2) status = "degraded";
      else status = "down";
      result[name] = { ...data, status, consecutive_failures: failures };
    }
    return result;
  } catch { return {}; }
}

// Load knowledge stats from component-status or session history
function loadKnowledgeStats() {
  // Try component-status.json which tracks pattern counts
  try {
    const cs = JSON.parse(readFileSync(join(__dirname, "component-status.json"), "utf8"));
    const kn = cs?.knowledge || cs?.patterns;
    if (kn?.total) return kn;
  } catch {}
  // Fallback: count from session history how many patterns we know about
  // The knowledge_read digest says 38 patterns — hardcode categories from last known state
  // This is a best-effort fallback; the publish utility can refresh this
  return {
    total: 38,
    categories: {
      architecture: 18,
      tooling: 9,
      reliability: 3,
      prompting: 3,
      ecosystem: 3,
      security: 2,
    },
  };
}

// Use execFileSync with args array to avoid shell escaping issues entirely
function runConvert(args, dest) {
  execFileSync("convert", args);
  return dest;
}

// Generate session activity bar chart (last 20 sessions)
export function generateSessionChart(outFile) {
  const sessions = parseSessionHistory();
  const recent = sessions.slice(-20);
  if (!recent.length) return null;

  const W = 800, H = 450;
  const barW = 30, gap = 8, startX = 70, startY = 380;
  const maxCost = Math.max(...recent.map(s => s.cost), 1);
  const scale = 280 / maxCost;
  const total = recent.reduce((a, s) => a + s.cost, 0).toFixed(2);

  const modeColors = { B: C.blue, E: C.green, R: C.purple, A: C.yellow };

  // Build draw primitives — each -draw gets its own argument
  const args = ["-size", `${W}x${H}`, "xc:none"];

  // Background
  args.push("-fill", C.bg, "-draw", `rectangle 0,0 ${W},${H}`);

  // Title
  args.push("-fill", C.text, "-font", "Courier", "-pointsize", "22",
    "-draw", `text 70,40 'Session Cost Tracker'`);
  args.push("-fill", C.textDim, "-pointsize", "13",
    "-draw", `text 70,62 'Last ${recent.length} sessions | Total: $${total}'`);

  // Y-axis labels and grid lines
  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const val = (maxCost / ySteps * i).toFixed(1);
    const y = startY - (i / ySteps * 280);
    args.push("-fill", C.textDim, "-pointsize", "11",
      "-draw", `text 10,${Math.round(y + 4)} '$${val}'`);
    args.push("-stroke", C.accentAlt, "-strokewidth", "1",
      "-draw", `line 65,${Math.round(y)} ${W - 20},${Math.round(y)}`);
    args.push("-stroke", "none");
  }

  // Bars
  recent.forEach((s, i) => {
    const x = startX + i * (barW + gap);
    const barH = s.cost * scale;
    const color = modeColors[s.mode] || C.accent;
    args.push("-fill", color,
      "-draw", `rectangle ${x},${Math.round(startY - barH)} ${x + barW},${startY}`);
    // Session label below
    const label = `${s.mode}${String(s.session).slice(-2)}`;
    args.push("-fill", C.textDim, "-pointsize", "9",
      "-draw", `text ${x + 2},${startY + 14} '${label}'`);
  });

  // Legend
  const legendY = H - 30;
  const legendItems = [
    { label: "Build", color: C.blue },
    { label: "Engage", color: C.green },
    { label: "Reflect", color: C.purple },
    { label: "Audit", color: C.yellow },
  ];
  legendItems.forEach((item, i) => {
    const lx = 70 + i * 130;
    args.push("-fill", item.color,
      "-draw", `rectangle ${lx},${legendY - 10} ${lx + 12},${legendY + 2}`);
    args.push("-fill", C.textDim, "-pointsize", "12",
      "-draw", `text ${lx + 18},${legendY} '${item.label}'`);
  });

  // Branding
  args.push("-fill", C.textDim, "-pointsize", "11",
    "-draw", `text ${W - 185},${H - 10} '@moltbook | terminalcraft.xyz'`);

  const dest = outFile || join(OUT_DIR, "session-costs.png");
  args.push(dest);
  return runConvert(args, dest);
}

// Generate platform health heatmap
export function generatePlatformHeatmap(outFile) {
  const platforms = Object.entries(loadPlatformHealth()).sort((a, b) => a[0].localeCompare(b[0]));
  if (!platforms.length) return null;

  const cellW = 36, cellH = 30, cols = 8, padding = 50;
  const rows = Math.ceil(platforms.length / cols);
  const W = cols * cellW + padding * 2 + 20;
  const H = rows * cellH + 140;

  const live = platforms.filter(([, d]) => d.status === "live").length;
  const degraded = platforms.filter(([, d]) => d.status === "degraded").length;
  const down = platforms.filter(([, d]) => d.status === "down").length;

  const args = ["-size", `${W}x${H}`, "xc:none"];
  args.push("-fill", C.bg, "-draw", `rectangle 0,0 ${W},${H}`);
  args.push("-fill", C.text, "-font", "Courier", "-pointsize", "20",
    "-draw", `text ${padding},35 'Platform Health Heatmap'`);
  args.push("-fill", C.textDim, "-pointsize", "12",
    "-draw", `text ${padding},55 '${platforms.length} platforms: ${live} live, ${degraded} degraded, ${down} down'`);

  platforms.forEach(([name, data], i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = padding + col * cellW;
    const y = 75 + row * cellH;

    let color;
    if (data.status === "live") color = C.green;
    else if (data.status === "degraded") color = C.yellow;
    else color = C.red;

    args.push("-fill", color,
      "-draw", `rectangle ${x},${y} ${x + cellW - 3},${y + cellH - 3}`);
    // Short platform name on the cell
    const short = name.replace(/\.(com|io|org|cc|app|dev|net|online|ai)$/, "").slice(0, 5);
    args.push("-fill", C.bg, "-pointsize", "7",
      "-draw", `text ${x + 2},${y + 17} '${short}'`);
  });

  // Legend
  const ly = H - 35;
  [
    { label: `Live (${live})`, color: C.green },
    { label: `Degraded (${degraded})`, color: C.yellow },
    { label: `Down (${down})`, color: C.red },
  ].forEach((item, i) => {
    const lx = padding + i * 130;
    args.push("-fill", item.color,
      "-draw", `rectangle ${lx},${ly - 8} ${lx + 10},${ly + 2}`);
    args.push("-fill", C.textDim, "-pointsize", "11",
      "-draw", `text ${lx + 16},${ly} '${item.label}'`);
  });

  args.push("-fill", C.textDim, "-pointsize", "11",
    "-draw", `text ${W - 185},${H - 10} '@moltbook | terminalcraft.xyz'`);

  const dest = outFile || join(OUT_DIR, "platform-health.png");
  args.push(dest);
  return runConvert(args, dest);
}

// Generate knowledge stats chart
export function generateKnowledgeChart(outFile) {
  const stats = loadKnowledgeStats();
  const W = 600, H = 400;

  const catColors = {
    architecture: C.blue,
    prompting: C.purple,
    tooling: C.green,
    reliability: C.yellow,
    security: C.red,
    ecosystem: C.accent,
  };

  const args = ["-size", `${W}x${H}`, "xc:none"];
  args.push("-fill", C.bg, "-draw", `rectangle 0,0 ${W},${H}`);
  args.push("-fill", C.text, "-font", "Courier", "-pointsize", "20",
    "-draw", `text 40,35 'Knowledge Base'`);
  args.push("-fill", C.textDim, "-pointsize", "13",
    "-draw", `text 40,55 '${stats.total} patterns across ${Object.keys(stats.categories).length} categories'`);

  // Horizontal stacked bar
  const barX = 40, barY = 80, barW = W - 80, barH = 40;
  let offset = 0;
  const entries = Object.entries(stats.categories).sort((a, b) => b[1] - a[1]);

  entries.forEach(([cat, count]) => {
    const segW = Math.max(stats.total > 0 ? (count / stats.total) * barW : 0, 4);
    const color = catColors[cat] || C.accentAlt;
    args.push("-fill", color,
      "-draw", `rectangle ${barX + offset},${barY} ${barX + offset + Math.round(segW)},${barY + barH}`);
    offset += segW;
  });

  // Category breakdown list
  let listY = 150;
  entries.forEach(([cat, count]) => {
    const color = catColors[cat] || C.accentAlt;
    const pct = stats.total > 0 ? ((count / stats.total) * 100).toFixed(0) : 0;
    args.push("-fill", color,
      "-draw", `rectangle 50,${listY - 10} 62,${listY + 2}`);
    args.push("-fill", C.text, "-pointsize", "14",
      "-draw", `text 72,${listY} '${cat}'`);
    args.push("-fill", C.textDim, "-pointsize", "14",
      "-draw", `text 230,${listY} '${count} patterns (${pct}%)'`);

    // Mini bar
    const miniBarW = Math.round((count / stats.total) * 150);
    args.push("-fill", color,
      "-draw", `rectangle 400,${listY - 10} ${400 + miniBarW},${listY + 2}`);
    listY += 32;
  });

  args.push("-fill", C.textDim, "-pointsize", "11",
    "-draw", `text ${W - 185},${H - 10} '@moltbook | terminalcraft.xyz'`);

  const dest = outFile || join(OUT_DIR, "knowledge-stats.png");
  args.push(dest);
  return runConvert(args, dest);
}

// Generate all charts
export function generateAll() {
  const results = [];
  try { results.push({ type: "session-costs", path: generateSessionChart() }); } catch (e) { results.push({ type: "session-costs", error: e.message }); }
  try { results.push({ type: "platform-health", path: generatePlatformHeatmap() }); } catch (e) { results.push({ type: "platform-health", error: e.message }); }
  try { results.push({ type: "knowledge-stats", path: generateKnowledgeChart() }); } catch (e) { results.push({ type: "knowledge-stats", error: e.message }); }
  return results;
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const type = process.argv[2] || "all";
  if (type === "all") {
    const results = generateAll();
    console.log(JSON.stringify(results, null, 2));
  } else if (type === "session") {
    console.log(generateSessionChart());
  } else if (type === "health") {
    console.log(generatePlatformHeatmap());
  } else if (type === "knowledge") {
    console.log(generateKnowledgeChart());
  } else {
    console.error("Usage: node clawsta-image-gen.mjs [all|session|health|knowledge]");
    process.exit(1);
  }
}
