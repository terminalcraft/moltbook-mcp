/**
 * platform-liveness-cache.mjs — Shared read/write access to liveness-cache.json
 *
 * Multiple tools (mention-scan, platform-picker, engage-orchestrator, liveness-probe)
 * independently probe platform APIs. This module provides a shared cache so one probe
 * result is reused across tools within a session.
 *
 * Usage:
 *   import { getCachedLiveness, setCachedLiveness, isCacheValid } from "./lib/platform-liveness-cache.mjs";
 *
 *   const cached = getCachedLiveness("4claw");
 *   if (cached && isCacheValid(cached)) {
 *     // Use cached result — skip probe
 *   } else {
 *     // Probe platform, then cache result
 *     setCachedLiveness("4claw", { reachable: true, healthy: true, status: 200 });
 *   }
 *
 * wq-504: Platform liveness cache with TTL for cross-tool sharing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CACHE_PATH = join(homedir(), ".config", "moltbook", "liveness-cache.json");
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (matches engagement-liveness-probe.mjs)

function loadCache() {
  if (!existsSync(CACHE_PATH)) return { entries: {} };
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { entries: {} };
  }
}

function saveCache(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

/**
 * Check if a cache entry is still valid (within TTL).
 * @param {object} entry - Cache entry with timestamp field
 * @param {number} [ttlMs] - TTL in milliseconds (default 2h)
 * @returns {boolean}
 */
export function isCacheValid(entry, ttlMs = DEFAULT_TTL_MS) {
  if (!entry || !entry.timestamp) return false;
  return (Date.now() - entry.timestamp) < ttlMs;
}

/**
 * Get cached liveness for a platform.
 * @param {string} platform - Platform name (lowercase key)
 * @returns {object|null} Cache entry or null if not found/expired
 */
export function getCachedLiveness(platform) {
  const cache = loadCache();
  const key = platform.toLowerCase().replace(/[.\s]/g, "");
  const entry = cache.entries?.[key];
  if (!entry) return null;
  if (!isCacheValid(entry)) return null;
  return entry;
}

/**
 * Set cached liveness for a platform.
 * @param {string} platform - Platform name (lowercase key)
 * @param {object} result - Probe result { reachable, healthy, status, [elapsed], [error] }
 * @param {number} [sessionNum] - Current session number
 */
export function setCachedLiveness(platform, result, sessionNum = 0) {
  const cache = loadCache();
  const key = platform.toLowerCase().replace(/[.\s]/g, "");
  cache.entries = cache.entries || {};
  cache.entries[key] = {
    timestamp: Date.now(),
    session: sessionNum || parseInt(process.env.SESSION_NUM) || 0,
    reachable: !!result.reachable,
    healthy: !!result.healthy,
    status: result.status || 0,
    ...(result.elapsed != null && { elapsed: result.elapsed }),
    ...(result.error && { error: result.error }),
  };
  saveCache(cache);
}

/**
 * Get all cached entries (for bulk checks).
 * @returns {object} Map of platform → entry
 */
export function getAllCachedLiveness() {
  return loadCache().entries || {};
}

/**
 * Check if a platform is known-reachable from cache (convenience).
 * @param {string} platform - Platform name
 * @param {number} [ttlMs] - Custom TTL
 * @returns {boolean|null} true/false if cached, null if no valid cache
 */
export function isReachable(platform, ttlMs = DEFAULT_TTL_MS) {
  const entry = getCachedLiveness(platform);
  if (!entry || !isCacheValid(entry, ttlMs)) return null;
  return entry.reachable;
}
