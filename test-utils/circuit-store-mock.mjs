// test-utils/circuit-store-mock.mjs — In-memory circuit store factory for tests
// Extracted from engage-orchestrator.test.mjs (wq-841).
// Provides createCircuitStore() and DI helpers for testing circuit breaker logic
// without filesystem access.

import { getCircuitState, CIRCUIT_FAILURE_THRESHOLD } from '../lib/circuit-breaker.mjs';
import { handleRecordOutcome, handleCircuitStatus } from '../lib/orchestrator-cli.mjs';

/**
 * Create an in-memory circuit store that mirrors the real file-based store API.
 * @param {Object} initial - Initial circuit state (platform → entry map)
 */
export function createCircuitStore(initial = {}) {
  let circuits = JSON.parse(JSON.stringify(initial));

  function recordOutcome(platform, success) {
    if (!circuits[platform]) {
      circuits[platform] = { consecutive_failures: 0, total_failures: 0, total_successes: 0, last_failure: null, last_success: null };
    }
    const entry = circuits[platform];
    if (success) {
      entry.consecutive_failures = 0;
      entry.total_successes++;
      entry.last_success = new Date().toISOString();
      // Auto-reopen: clear closed status on success (d078)
      if (entry.status === "closed") {
        delete entry.status;
      }
    } else {
      entry.consecutive_failures++;
      entry.total_failures++;
      entry.last_failure = new Date().toISOString();
      // Auto-circuit-break: set status closed when threshold reached (d078, wq-978)
      if (entry.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD && entry.status !== "closed") {
        entry.status = "closed";
        entry.notes = `Auto-circuit-broken at ${entry.consecutive_failures} consecutive failures (${new Date().toISOString()})`;
      }
    }
    return { platform, state: getCircuitState(circuits, platform), ...entry };
  }

  return {
    loadCircuits: () => circuits,
    getCircuitState: (circs, platform) => getCircuitState(circs, platform),
    recordOutcome,
    setCircuits: (c) => { circuits = JSON.parse(JSON.stringify(c)); },
  };
}

/**
 * Call handleRecordOutcome via DI and return the parsed JSON result.
 */
export function diRecordOutcome(store, platform, outcome) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    handleRecordOutcome(
      ['--record-outcome', platform, outcome],
      { recordOutcome: store.recordOutcome, exit: () => {} }
    );
  } finally {
    console.log = origLog;
  }
  return JSON.parse(logs.join(''));
}

/**
 * Call handleCircuitStatus via DI and return the parsed JSON result.
 */
export function diGetCircuitStatus(store) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    handleCircuitStatus(
      ['--circuit-status'],
      { loadCircuits: store.loadCircuits, getCircuitState: store.getCircuitState, exit: () => {} }
    );
  } finally {
    console.log = origLog;
  }
  return JSON.parse(logs.join(''));
}
