/**
 * Session Context Provider (wq-208)
 *
 * Provides session metadata and pre-computed context to components.
 * Extracted from index.js as part of Components/Providers/Transforms refactor.
 *
 * Components receive this context object in their register() call, enabling
 * context-aware initialization without re-reading env vars or files.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Compute directive staleness and relevance at startup.
 * Enables components and hooks to act on directive urgency without re-parsing directives.json.
 *
 * @param {number} sessionNum - Current session number
 * @param {string} sessionType - Session type (B/E/R/A)
 * @param {string} baseDir - Base directory for directives.json
 * @returns {Object} Directive health object
 */
export function computeDirectiveHealth(sessionNum, sessionType, baseDir) {
  const directivesPath = join(baseDir, 'directives.json');
  const health = {
    computed: new Date().toISOString(),
    sessionNum,
    sessionType,
    active: [],
    stale: [],      // active directives >20 sessions without update
    urgent: [],     // directives explicitly needing this session type
    summary: { total: 0, active: 0, stale: 0, urgent: 0 }
  };

  if (!existsSync(directivesPath)) return health;

  try {
    const data = JSON.parse(readFileSync(directivesPath, 'utf8'));
    const directives = data.directives || [];
    health.summary.total = directives.length;

    // Session-type relevance hints (from directive content patterns)
    const typeHints = {
      E: ['engage', 'platform', 'pinchwork', 'post', 'task', 'email'],
      B: ['build', 'fix', 'implement', 'add', 'test', 'refactor'],
      R: ['review', 'check', 'audit', 'reflect', 'evolve', 'directive', 'maintenance', 'compliance'],
      A: ['audit', 'escalation', 'blocked', 'stale']
    };

    for (const d of directives) {
      if (d.status !== 'active') continue;

      const ackedSession = d.acked_session || d.session || 0;
      const sessionsSinceAck = sessionNum - ackedSession;
      const lastUpdate = d.updated ? new Date(d.updated).getTime() : null;
      const content = (d.content || '').toLowerCase();

      const entry = {
        id: d.id,
        sessionsSinceAck,
        lastUpdate,
        contentPreview: d.content?.slice(0, 80) + (d.content?.length > 80 ? '...' : '')
      };

      health.active.push(entry);
      health.summary.active++;

      // Mark as stale if >20 sessions without progress
      if (sessionsSinceAck > 20) {
        health.stale.push(entry);
        health.summary.stale++;
      }

      // Check session-type relevance
      const hints = typeHints[sessionType] || [];
      if (hints.some(h => content.includes(h))) {
        health.urgent.push(entry);
        health.summary.urgent++;
      }
    }
  } catch { /* ignore parse errors */ }

  return health;
}

/**
 * Create the session context object that gets passed to all components.
 *
 * @param {Object} options - Configuration options
 * @param {number} options.sessionNum - Current session number
 * @param {string} options.sessionType - Session type (B/E/R/A)
 * @param {string} options.baseDir - Base directory (__dirname of index.js)
 * @param {number} options.budgetCap - Budget cap for this session
 * @returns {Object} Session context object
 */
export function createSessionContext({ sessionNum, sessionType, baseDir, budgetCap }) {
  const stateDir = join(process.env.HOME || '', '.config/moltbook');

  return {
    sessionNum,
    sessionType,
    dir: baseDir,
    stateDir,
    budgetCap,

    // Lazy-load pre-computed context from session-context.mjs output
    _precomputed: null,
    get precomputed() {
      if (this._precomputed === null) {
        const envPath = join(this.stateDir, 'session-context.env');
        if (existsSync(envPath)) {
          try {
            const raw = readFileSync(envPath, 'utf8');
            this._precomputed = {};
            for (const line of raw.split('\n')) {
              const match = line.match(/^CTX_([A-Z_]+)=(.*)$/);
              if (match) {
                let val = match[2];
                if (val.startsWith("$'") && val.endsWith("'")) {
                  val = val.slice(2, -1).replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
                } else if (val.startsWith("'") && val.endsWith("'")) {
                  val = val.slice(1, -1).replace(/'\\'''/g, "'");
                }
                this._precomputed[match[1].toLowerCase()] = val;
              }
            }
          } catch { this._precomputed = {}; }
        } else {
          this._precomputed = {};
        }
      }
      return this._precomputed;
    },

    // Directive health computed at startup for component awareness
    _directiveHealth: null,
    get directiveHealth() {
      if (this._directiveHealth === null) {
        this._directiveHealth = computeDirectiveHealth(sessionNum, sessionType, baseDir);
      }
      return this._directiveHealth;
    }
  };
}
