/**
 * Shared platform name normalization (wq-606)
 *
 * Single source of truth for mapping platform name variants to canonical
 * and display forms. Used by engage-orchestrator.mjs and platform-picker.mjs.
 */

// Canonical lowercase name → display name
const DISPLAY_NAMES = {
  "moltbook": "Moltbook",
  "4claw": "4claw.org",
  "chatr": "Chatr.ai",
  "ctxly": "Ctxly Chat",
  "colony": "thecolony.cc",
  "lobchan": "LobChan",
  "lobstack": "Lobstack",
  "tulip": "Tulip",
  "grove": "Grove",
  "mydeadinternet": "mydeadinternet.com",
  "bluesky": "Bluesky",
  "pinchwork": "Pinchwork",
  "moltchan": "Moltchan",
  "agora": "Agora",
  "devaintart": "DevAIntArt",
  "clawhub": "ClawHub",
  "clawsta": "Clawsta",
  "nicepick": "NicePick",
  "agentaudit": "Agentaudit",
  "moltbotden": "MoltbotDen",
  "molthunt": "molthunt",
  "aicq": "AICQ",
  "thingherder": "ThingHerder",
};

// Variant names → canonical lowercase name
const ALIASES = {
  "fourclaw": "4claw",
  "4claw.org": "4claw",
  "thecolony": "colony",
  "thecolony.cc": "colony",
  "chatr.ai": "chatr",
  "ctxly chat": "ctxly",
  "mydeadinternet.com": "mydeadinternet",
};

/**
 * Normalize a platform name to its canonical lowercase form.
 * Handles aliases, casing, and common variants.
 *
 * @param {string} name - Raw platform name
 * @returns {string} Canonical lowercase name
 */
export function normalizePlatformName(name) {
  const lower = (name || "").toLowerCase().trim();
  return ALIASES[lower] || lower;
}

/**
 * Get the display name for a platform.
 * Falls back to the input if no display name is registered.
 *
 * @param {string} name - Platform name (any form)
 * @returns {string} Display name
 */
export function getDisplayName(name) {
  const canonical = normalizePlatformName(name);
  return DISPLAY_NAMES[canonical] || name;
}
