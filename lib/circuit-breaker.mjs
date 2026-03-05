#!/usr/bin/env node
/**
 * circuit-breaker.mjs — Per-platform circuit breaker for engagement reliability.
 *
 * States: closed (healthy) → open (disabled after N failures) → half-open (retry after cooldown)
 * Defunct platforms are permanently excluded.
 *
 * Extracted from engage-orchestrator.mjs in R#310.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = join(__dirname, "..", "platform-circuits.json");

// Circuit breaker config
const CIRCUIT_FAILURE_THRESHOLD = 3;  // consecutive failures to open circuit
const CIRCUIT_COOLDOWN_MS = 24 * 3600 * 1000;  // 24h before half-open retry

export { CIRCUIT_FAILURE_THRESHOLD, CIRCUIT_COOLDOWN_MS };

export function loadCircuits() {
  if (!existsSync(CIRCUIT_PATH)) return {};
  try { return JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")); } catch { return {}; }
}

export function saveCircuits(circuits) {
  writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + "\n");
}

export function getCircuitState(circuits, platform) {
  const entry = circuits[platform];
  if (!entry || entry.consecutive_failures < CIRCUIT_FAILURE_THRESHOLD) return "closed";
  // wq-319: Defunct platforms are permanently excluded
  if (entry.status === "defunct") return "defunct";
  // Check if cooldown has expired → half-open
  const elapsed = Date.now() - new Date(entry.last_failure).getTime();
  if (elapsed >= CIRCUIT_COOLDOWN_MS) return "half-open";
  return "open";
}

export function recordOutcome(platform, success) {
  const circuits = loadCircuits();
  if (!circuits[platform]) {
    circuits[platform] = { consecutive_failures: 0, total_failures: 0, total_successes: 0, last_failure: null, last_success: null };
  }
  const entry = circuits[platform];
  if (success) {
    entry.consecutive_failures = 0;
    entry.total_successes++;
    entry.last_success = new Date().toISOString();
  } else {
    entry.consecutive_failures++;
    entry.total_failures++;
    entry.last_failure = new Date().toISOString();
  }
  saveCircuits(circuits);
  return { platform, state: getCircuitState(circuits, platform), ...entry };
}

export function filterByCircuit(platformNames) {
  const circuits = loadCircuits();
  const allowed = [];
  const blocked = [];
  const halfOpen = [];
  const defunct = [];  // wq-319: Track defunct platforms separately
  for (const name of platformNames) {
    const state = getCircuitState(circuits, name);
    if (state === "defunct") {
      // wq-319: Defunct platforms are permanently excluded
      const entry = circuits[name];
      defunct.push({ platform: name, defunct_at: entry.defunct_at, reason: entry.defunct_reason });
    } else if (state === "open") {
      const entry = circuits[name];
      blocked.push({ platform: name, failures: entry.consecutive_failures, last_failure: entry.last_failure });
    } else if (state === "half-open") {
      halfOpen.push(name);
      allowed.push(name); // allow one retry
    } else {
      allowed.push(name);
    }
  }
  return { allowed, blocked, halfOpen, defunct };
}
