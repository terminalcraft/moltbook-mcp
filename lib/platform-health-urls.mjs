/**
 * Shared platform health URL mapping (wq-859)
 *
 * Single source of truth for HTTP health-check URLs used by circuit probes.
 * Supplements account-registry.json test URLs for platforms that use MCP or
 * file_exists test methods.
 *
 * Used by: open-circuit-repair.mjs, circuit-reset-probe.mjs, defunct-platform-probe.mjs
 */

import { normalizePlatformName } from "./platform-names.mjs";

// Canonical platform name → health check URL
const HEALTH_URLS = {
  // Live platforms
  moltbook: "https://moltbook.xyz",
  "4claw": "https://4claw.org",
  chatr: "https://chatr.ai",
  ctxly: "https://ctxly.com",
  colony: "https://thecolony.cc",
  mydeadinternet: "https://mydeadinternet.com",
  pinchwork: "https://pinchwork.dev",
  grove: "https://grove.ctxly.app",
  moltchan: "https://www.moltchan.org",
  agentaudit: "https://agentaudit.ai",
  "home-ctxly": "https://ctxly.com",
  "memoryvault-link": "https://memoryvault.link",
  molthunt: "https://molthunt.com",
  tulip: "https://tulip.fg-goose.online",
  lobstack: "https://lobstack.ai",
  darkclawbook: "https://darkclawbook.self.md",
  lobchan: "https://lobchan.com",
  lobsterpedia: "https://lobsterpedia.com",
  // Defunct platforms (kept for recovery probing)
  clawhub: "https://clawhub.dev/api/health",
  colonysim: "https://colonysim.io/api/status",
  soulmarket: "https://soulmarket.ai/api/health",
  openwork: "https://openwork.ai/api/jobs",
};

/**
 * Get the health check URL for a platform.
 * Normalizes the platform name via platform-names.mjs aliases,
 * then checks the hardcoded map, then falls back to registry test URL.
 *
 * @param {string} platformId - Platform identifier (any variant)
 * @param {object} [registry] - Parsed account-registry.json (optional)
 * @returns {string|null} Health check URL or null
 */
export function getHealthUrl(platformId, registry) {
  const canonical = normalizePlatformName(platformId);
  if (HEALTH_URLS[canonical]) return HEALTH_URLS[canonical];

  // Also try raw lowercase (for IDs like "home-ctxly" that aren't in aliases)
  const raw = platformId.toLowerCase();
  if (HEALTH_URLS[raw]) return HEALTH_URLS[raw];

  // Fall back to registry test URL
  const account = registry?.accounts?.find(
    (a) => a.id === platformId || a.platform?.toLowerCase() === raw
  );
  if (account?.test?.url) return account.test.url;

  return null;
}
