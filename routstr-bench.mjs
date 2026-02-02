#!/usr/bin/env node
// routstr-bench.mjs — Routstr model benchmarking & catalog tool
// Fetches all 333+ models from api.routstr.com, analyzes pricing/capabilities,
// ranks by cost-efficiency for common agent tasks, outputs public JSON report.

import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

const API = "https://api.routstr.com/v1/models";
const OUT = join(import.meta.dirname || ".", "routstr-benchmark.json");

// Agent task categories and what matters for each
const TASK_PROFILES = {
  "code-generation": { needsLargeContext: true, prefersLowCost: true, modality: "text", minContext: 32000 },
  "code-review": { needsLargeContext: true, prefersLowCost: true, modality: "text", minContext: 16000 },
  "chat-agent": { needsLargeContext: false, prefersLowCost: true, modality: "text", minContext: 8000 },
  "vision-analysis": { needsLargeContext: false, prefersLowCost: false, modality: "text+image", minContext: 4000 },
  "document-processing": { needsLargeContext: true, prefersLowCost: true, modality: "text", minContext: 64000 },
  "reasoning": { needsLargeContext: false, prefersLowCost: false, modality: "text", minContext: 8000 },
};

function scoreCostEfficiency(model) {
  const p = model.pricing;
  if (!p) return null;
  const avgCostPer1k = ((p.prompt || 0) + (p.completion || 0)) * 500;
  if (avgCostPer1k === 0) return null;
  // tokens-per-dollar (higher = cheaper)
  const tokensPerDollar = avgCostPer1k > 0 ? 1 / avgCostPer1k : Infinity;
  return { avgCostPer1kTokens: avgCostPer1k, tokensPerDollar };
}

function classifyModel(model) {
  const id = model.id.toLowerCase();
  const name = (model.name || "").toLowerCase();
  const desc = (model.description || "").toLowerCase();
  const tags = [];

  if (id.includes("codex") || id.includes("code") || desc.includes("coding") || desc.includes("software engineer")) tags.push("coding");
  if (id.includes("flash") || id.includes("mini") || id.includes("nano") || id.includes("lite")) tags.push("fast");
  if (id.includes("pro") || id.includes("opus") || id.includes("ultra")) tags.push("premium");
  if (desc.includes("reason") || id.includes("think") || id.includes("r1")) tags.push("reasoning");
  if (desc.includes("roleplay") || desc.includes("character") || id.includes("rp")) tags.push("roleplay");
  if (model.architecture?.input_modalities?.includes("image")) tags.push("vision");
  if (model.architecture?.input_modalities?.includes("audio")) tags.push("audio");
  if ((model.context_length || 0) >= 100000) tags.push("long-context");
  if (desc.includes("free") || ((model.pricing?.prompt || 0) === 0 && (model.pricing?.completion || 0) === 0)) tags.push("free");

  return tags;
}

function rankForTask(models, taskProfile) {
  return models
    .filter(m => {
      if (taskProfile.modality === "text+image" && !m.tags.includes("vision")) return false;
      if ((m.context_length || 0) < taskProfile.minContext) return false;
      if (!m.costMetrics) return false;
      return true;
    })
    .sort((a, b) => {
      // For cost-sensitive tasks, sort by cost. Otherwise by context length (proxy for capability).
      if (taskProfile.prefersLowCost) {
        return a.costMetrics.avgCostPer1kTokens - b.costMetrics.avgCostPer1kTokens;
      }
      return (b.context_length || 0) - (a.context_length || 0);
    })
    .slice(0, 15)
    .map((m, i) => ({
      rank: i + 1,
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      costPer1kTokens: m.costMetrics.avgCostPer1kTokens,
      satsPer1kTokens: m.satsCostMetrics?.avgCostPer1kTokens || null,
      tags: m.tags,
    }));
}

async function main() {
  console.log("Fetching models from Routstr API...");
  const res = await fetch(API);
  if (!res.ok) { console.error(`API error: ${res.status}`); process.exit(1); }
  const { data } = await res.json();
  console.log(`Fetched ${data.length} models`);

  // Enrich each model
  const models = data.map(m => {
    const tags = classifyModel(m);
    const costMetrics = scoreCostEfficiency(m);
    const satsCostMetrics = m.sats_pricing ? {
      avgCostPer1kTokens: ((m.sats_pricing.prompt || 0) + (m.sats_pricing.completion || 0)) * 500
    } : null;
    return { ...m, tags, costMetrics, satsCostMetrics };
  });

  // Global stats
  const enabledCount = models.filter(m => m.enabled).length;
  const withPricing = models.filter(m => m.costMetrics).length;
  const freeModels = models.filter(m => m.tags.includes("free"));
  const modalityCounts = {};
  models.forEach(m => {
    const mod = m.architecture?.modality || "unknown";
    modalityCounts[mod] = (modalityCounts[mod] || 0) + 1;
  });
  const tagCounts = {};
  models.forEach(m => m.tags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));

  // Provider breakdown
  const providers = {};
  models.forEach(m => {
    const provider = m.top_provider?.is_moderated !== undefined
      ? (m.name?.split(":")?.[0]?.trim() || "unknown")
      : "unknown";
    providers[provider] = (providers[provider] || 0) + 1;
  });

  // Top cheapest models
  const cheapest = models
    .filter(m => m.costMetrics && m.costMetrics.avgCostPer1kTokens > 0)
    .sort((a, b) => a.costMetrics.avgCostPer1kTokens - b.costMetrics.avgCostPer1kTokens)
    .slice(0, 20)
    .map(m => ({ id: m.id, name: m.name, costPer1kTokens: m.costMetrics.avgCostPer1kTokens, context: m.context_length, tags: m.tags }));

  // Largest context windows
  const largestContext = models
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
    .slice(0, 15)
    .map(m => ({ id: m.id, name: m.name, context_length: m.context_length, costPer1kTokens: m.costMetrics?.avgCostPer1kTokens }));

  // Per-task rankings
  const taskRankings = {};
  for (const [task, profile] of Object.entries(TASK_PROFILES)) {
    taskRankings[task] = rankForTask(models, profile);
  }

  const report = {
    meta: {
      generated: new Date().toISOString(),
      source: API,
      totalModels: data.length,
      enabledModels: enabledCount,
      modelsWithPricing: withPricing,
      freeModels: freeModels.length,
    },
    stats: {
      modalityCounts,
      tagCounts,
      providerCounts: providers,
    },
    rankings: {
      cheapest,
      largestContext,
      byTask: taskRankings,
    },
    // Full model catalog (compact)
    catalog: models.map(m => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      modality: m.architecture?.modality,
      enabled: m.enabled,
      tags: m.tags,
      pricing_usd: m.costMetrics ? { per1kTokens: m.costMetrics.avgCostPer1kTokens } : null,
      pricing_sats: m.satsCostMetrics ? { per1kTokens: m.satsCostMetrics.avgCostPer1kTokens } : null,
    })),
  };

  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`Report written to ${OUT}`);
  console.log(`\nSummary: ${data.length} models, ${enabledCount} enabled, ${freeModels.length} free`);
  console.log(`Top 5 cheapest: ${cheapest.slice(0, 5).map(m => `${m.id} ($${m.costPer1kTokens.toFixed(6)}/1k)`).join(", ")}`);
  console.log(`Largest context: ${largestContext.slice(0, 3).map(m => `${m.id} (${(m.context_length/1000).toFixed(0)}k)`).join(", ")}`);

  return report;
}

export { main };

// Run if called directly
if (process.argv[1]?.endsWith("routstr-bench.mjs")) {
  main().catch(console.error);
}
