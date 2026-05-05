#!/usr/bin/env node
/**
 * prune-dead-platforms.mjs — Lightweight DNS-only pruner for services.json.
 * wq-999: Marks platforms with persistent NXDOMAIN as "defunct".
 *
 * Unlike service-liveness.mjs --update (which does full HTTP probes),
 * this only resolves DNS — fast enough for routine A-session checks.
 *
 * Usage:
 *   node prune-dead-platforms.mjs            # Dry-run: report dead platforms
 *   node prune-dead-platforms.mjs --apply    # Mark dead platforms as defunct in services.json
 *   node prune-dead-platforms.mjs --resurrect # Also check defunct platforms for recovery
 *
 * Threshold: 2 consecutive DNS failures (matching service-liveness.mjs wq-790 logic).
 * On first run after outage, resets counters for services that now resolve.
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dns from "dns/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_PATH = resolve(__dirname, "services.json");
const DNS_DEFUNCT_THRESHOLD = 2;

const args = process.argv.slice(2);
const flagApply = args.includes("--apply");
const flagResurrect = args.includes("--resurrect");

async function resolveDns(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const data = JSON.parse(readFileSync(SERVICES_PATH, "utf8"));

  // Filter: check active/evaluated/integrated services (skip rejected)
  // If --resurrect, also check defunct services for recovery
  const candidates = data.services.filter(s => {
    if (s.status === "rejected") return false;
    if (s.status === "defunct") return flagResurrect;
    return true;
  });

  const changes = [];
  const resolved = [];
  const failed = [];

  // Batch DNS lookups (fast — just DNS, no HTTP)
  const results = await Promise.allSettled(
    candidates.map(async (svc) => {
      const url = new URL(svc.url);
      const alive = await resolveDns(url.hostname);
      return { svc, alive, hostname: url.hostname };
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { svc, alive, hostname } = result.value;

    if (!svc.liveness) svc.liveness = {};

    if (alive) {
      // DNS resolves — reset counter
      if (svc.liveness.consecutiveDnsFails > 0) {
        svc.liveness.consecutiveDnsFails = 0;
        resolved.push(svc.name);
      }
      // Resurrect defunct services whose DNS is back
      if (svc.status === "defunct" && svc.defunctReason === "dns_nxdomain") {
        svc.status = "evaluated";
        delete svc.defunctAt;
        delete svc.defunctReason;
        changes.push(`RESURRECTED: ${svc.name} (${hostname} now resolves)`);
      }
    } else {
      // DNS failed
      svc.liveness.consecutiveDnsFails = (svc.liveness.consecutiveDnsFails || 0) + 1;
      failed.push({ name: svc.name, hostname, streak: svc.liveness.consecutiveDnsFails });

      if (svc.liveness.consecutiveDnsFails >= DNS_DEFUNCT_THRESHOLD &&
          svc.status !== "defunct") {
        svc.status = "defunct";
        svc.defunctAt = new Date().toISOString();
        svc.defunctReason = "dns_nxdomain";
        changes.push(`DEFUNCT: ${svc.name} (${hostname} — ${svc.liveness.consecutiveDnsFails} consecutive DNS failures)`);
      }
    }
  }

  // Report
  const total = candidates.length;
  const aliveCount = total - failed.length;
  console.log(`DNS check: ${total} services — ${aliveCount} resolve, ${failed.length} fail`);

  if (resolved.length > 0) {
    console.log(`\nRecovered (DNS counter reset): ${resolved.join(", ")}`);
  }

  if (failed.length > 0) {
    console.log(`\nDNS failures:`);
    for (const f of failed) {
      const tag = f.streak >= DNS_DEFUNCT_THRESHOLD ? " [DEFUNCT]" : ` (${f.streak}/${DNS_DEFUNCT_THRESHOLD})`;
      console.log(`  ${f.name} — ${f.hostname}${tag}`);
    }
  }

  if (changes.length > 0) {
    console.log(`\nChanges${flagApply ? " (applied)" : " (dry-run, use --apply)"}:`);
    for (const c of changes) console.log(`  ${c}`);
  }

  if (flagApply && (changes.length > 0 || resolved.length > 0)) {
    data.lastUpdated = new Date().toISOString();
    writeFileSync(SERVICES_PATH, JSON.stringify(data, null, 2) + "\n");
    console.log(`\nservices.json updated.`);
  } else if (!flagApply && changes.length > 0) {
    console.log(`\nRe-run with --apply to write changes.`);
  }

  // Exit code: 0 = clean, 1 = changes pending (useful for hooks)
  process.exit(changes.length > 0 && !flagApply ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
