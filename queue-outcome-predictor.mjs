/**
 * Queue Outcome Predictor (wq-324)
 *
 * Predicts which queue items will complete vs block/retire based on:
 * 1. Source type (intel-auto has 100% retire rate, todo-scan 100% false positive)
 * 2. Description patterns (conditional language, observational tone)
 * 3. Dependency presence
 * 4. Complexity tags
 *
 * Analysis from s1087 (B#306):
 * - total items: 63, retired: 58, blocked: 1, pending: 3, in-progress: 1
 * - Retirement reasons: duplicate/exists (22), false_positive (10), wrong_session_type (6),
 *   non-actionable (5), premature (5), superseded (3)
 * - Sources with 100% retire rate: intel-auto (6/6), todo-scan (12/12)
 * - Sources with high retire rate: brainstorming-auto (28/29 = 97%)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = join(__dirname, 'work-queue.json');

// Risk factors derived from historical analysis
const SOURCE_RISK = {
  'intel-auto': 0.95,           // 100% retire rate - almost always non-actionable
  'todo-scan': 0.90,            // 100% retire rate - mostly false positives
  'brainstorming-auto': 0.70,   // 97% retire rate - often duplicates/premature
  'session': 0.60,              // high context-dependency, often premature
  'audit-s756': 0.50,           // audit items have moderate success
  'audit-s778': 0.50,
  'audit-s836': 0.50,
  'B#162-service-eval': 0.50,
  'R#141-brainstorm-promote': 0.40,
  'brainstorming-promote': 0.30, // manually promoted = more likely actionable
  'intel-evaluation': 0.25,     // evaluated intel = more concrete
  'directive': 0.15,            // human directives = usually actionable
};

// Description patterns that indicate low success probability
const WARNING_PATTERNS = [
  { pattern: /\b(could|might|may|if|when|consider)\b/i, risk: 0.15, reason: 'conditional_language' },
  { pattern: /\bfrom\s+(engagement\s+)?intel\b/i, risk: 0.20, reason: 'intel_derived' },
  { pattern: /\bFrom\s+s\d+\s+intel\b/i, risk: 0.20, reason: 'intel_reference' },
  { pattern: /\(added\s+~s\d+\)/i, risk: 0.10, reason: 'session_annotation' },
  { pattern: /\b(observation|philosophical|insight)\b/i, risk: 0.25, reason: 'observational' },
  { pattern: /\brevisit\s+if\b/i, risk: 0.20, reason: 'deferred_conditional' },
  { pattern: /\b(monitor|track|watch)\s+(for|until)\b/i, risk: 0.15, reason: 'monitoring_task' },
  { pattern: /TODO\s+followup:/i, risk: 0.30, reason: 'todo_scan_pattern' },
  { pattern: /\bAddress\s+directive\s+d\d+\b/i, risk: 0.10, reason: 'directive_address' },
  { pattern: /\bAdd\s+tests\s+for\b/i, risk: 0.15, reason: 'test_addition_often_unneeded' },
];

// Positive patterns that indicate higher success probability
const SUCCESS_PATTERNS = [
  { pattern: /\b(fix|implement|build|add|create)\b/i, reduction: 0.10, reason: 'imperative_verb' },
  { pattern: /\b(endpoint|API|tool|component)\b/i, reduction: 0.05, reason: 'concrete_artifact' },
  { pattern: /\bprerequisite|depends?\s+on\b/i, reduction: -0.10, reason: 'has_dependencies' },
  { pattern: /\bblocked\s+on\s+human\b/i, reduction: -0.20, reason: 'human_blocked' },
];

/**
 * Calculate risk score for a queue item
 * @param {Object} item - Queue item from work-queue.json
 * @returns {Object} Risk assessment with score, factors, and recommendation
 */
export function predictOutcome(item) {
  const factors = [];
  let riskScore = 0.30; // Base risk - most items have some completion chance

  // Factor 1: Source type
  const sourceRisk = SOURCE_RISK[item.source] ?? SOURCE_RISK[item.source?.split('-')[0]] ?? 0.35;
  riskScore += sourceRisk * 0.4; // Source accounts for 40% of prediction
  factors.push({
    factor: 'source',
    value: item.source,
    impact: sourceRisk,
    weight: 0.4
  });

  // Factor 2: Description pattern analysis
  const description = `${item.title || ''} ${item.description || ''}`;
  let patternRisk = 0;
  const warningsMatched = [];

  for (const { pattern, risk, reason } of WARNING_PATTERNS) {
    if (pattern.test(description)) {
      patternRisk += risk;
      warningsMatched.push(reason);
    }
  }

  // Check success patterns
  const successMatched = [];
  for (const { pattern, reduction, reason } of SUCCESS_PATTERNS) {
    if (pattern.test(description)) {
      patternRisk += reduction; // reduction is negative for success patterns
      successMatched.push(reason);
    }
  }

  // Clamp pattern risk
  patternRisk = Math.max(0, Math.min(0.5, patternRisk));
  riskScore += patternRisk * 0.35; // Patterns account for 35% of prediction
  factors.push({
    factor: 'patterns',
    warnings: warningsMatched,
    successes: successMatched,
    impact: patternRisk,
    weight: 0.35
  });

  // Factor 3: Dependencies
  const hasDeps = item.deps && item.deps.length > 0;
  if (hasDeps) {
    riskScore += 0.15 * 0.15; // Small increase - deps add complexity
    factors.push({
      factor: 'dependencies',
      value: item.deps,
      impact: 0.15,
      weight: 0.15
    });
  }

  // Factor 4: Tags
  const tags = item.tags || [];
  let tagRisk = 0;
  if (tags.includes('intel')) tagRisk += 0.20;
  if (tags.includes('deferred')) tagRisk += 0.15;
  if (tags.includes('followup')) tagRisk += 0.25;
  if (tags.includes('audit')) tagRisk -= 0.10; // audit items are generally valid
  if (tags.includes('security')) tagRisk -= 0.05; // security items usually important

  tagRisk = Math.max(-0.2, Math.min(0.3, tagRisk));
  riskScore += tagRisk * 0.10; // Tags account for 10% of prediction
  factors.push({
    factor: 'tags',
    value: tags,
    impact: tagRisk,
    weight: 0.10
  });

  // Normalize final score to 0-1 range
  riskScore = Math.max(0, Math.min(1, riskScore));

  // Generate recommendation
  let recommendation;
  if (riskScore >= 0.70) {
    recommendation = 'high_risk';
  } else if (riskScore >= 0.50) {
    recommendation = 'moderate_risk';
  } else if (riskScore >= 0.30) {
    recommendation = 'acceptable';
  } else {
    recommendation = 'likely_success';
  }

  return {
    id: item.id,
    title: item.title,
    risk_score: Math.round(riskScore * 100) / 100,
    recommendation,
    factors,
    predicted_outcome: riskScore >= 0.50 ? 'likely_retire' : 'likely_complete'
  };
}

/**
 * Predict outcomes for all pending items in the queue
 * @returns {Object} Summary with predictions and queue health metrics
 */
export function predictQueue() {
  if (!existsSync(QUEUE_PATH)) {
    return { error: 'work-queue.json not found' };
  }

  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  const pendingItems = queue.queue.filter(i => i.status === 'pending' || i.status === 'in-progress');

  const predictions = pendingItems.map(predictOutcome);

  // Calculate queue health metrics
  const avgRisk = predictions.length > 0
    ? predictions.reduce((sum, p) => sum + p.risk_score, 0) / predictions.length
    : 0;

  const highRiskCount = predictions.filter(p => p.recommendation === 'high_risk').length;
  const moderateRiskCount = predictions.filter(p => p.recommendation === 'moderate_risk').length;

  return {
    queue_health: {
      pending_count: pendingItems.length,
      avg_risk_score: Math.round(avgRisk * 100) / 100,
      high_risk_items: highRiskCount,
      moderate_risk_items: moderateRiskCount,
      recommendation: avgRisk >= 0.60 ? 'replenish_queue' : avgRisk >= 0.45 ? 'review_items' : 'healthy'
    },
    predictions: predictions.sort((a, b) => b.risk_score - a.risk_score)
  };
}

/**
 * Validate predictor against historical outcomes
 * @returns {Object} Validation metrics
 */
export function validatePredictor() {
  if (!existsSync(QUEUE_PATH)) {
    return { error: 'work-queue.json not found' };
  }

  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
  const retiredItems = queue.queue.filter(i => i.status === 'retired');

  // For retired items, we know the outcome - test if predictor would have predicted correctly
  let correctPredictions = 0;
  let totalPredictions = 0;
  const misclassified = [];

  for (const item of retiredItems) {
    const prediction = predictOutcome(item);
    totalPredictions++;

    // Most retired items should have been predicted as likely_retire
    if (prediction.predicted_outcome === 'likely_retire') {
      correctPredictions++;
    } else {
      misclassified.push({
        id: item.id,
        title: item.title,
        predicted: prediction.predicted_outcome,
        actual: 'retired',
        risk_score: prediction.risk_score,
        notes: item.notes?.substring(0, 100)
      });
    }
  }

  return {
    accuracy: totalPredictions > 0 ? Math.round((correctPredictions / totalPredictions) * 100) : 0,
    correct: correctPredictions,
    total: totalPredictions,
    misclassified: misclassified.slice(0, 10), // Top 10 misclassifications
    note: 'Validation against retired items only. Blocked/in-progress items excluded.'
  };
}

// CLI interface
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'predict';

  if (command === 'predict') {
    console.log(JSON.stringify(predictQueue(), null, 2));
  } else if (command === 'validate') {
    console.log(JSON.stringify(validatePredictor(), null, 2));
  } else if (command === 'item' && process.argv[3]) {
    const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
    const item = queue.queue.find(i => i.id === process.argv[3]);
    if (item) {
      console.log(JSON.stringify(predictOutcome(item), null, 2));
    } else {
      console.log({ error: `Item ${process.argv[3]} not found` });
    }
  } else {
    console.log('Usage: node queue-outcome-predictor.mjs [predict|validate|item <id>]');
  }
}
