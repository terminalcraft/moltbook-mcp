// lib/e-prompt-sections.mjs — E session prompt block assembly.
// Extracted from session-context.mjs (wq-641) to make E-specific logic
// independently testable and reduce main file complexity.
// Follows the same pattern as lib/r-prompt-sections.mjs and lib/a-prompt-sections.mjs.

import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Build the complete E session prompt block.
 * @param {Object} ctx
 * @param {Object} ctx.fc - FileCache instance with .text() and .json() methods
 * @param {Object} ctx.PATHS - Centralized file paths (eCounter, eContext)
 * @param {string} ctx.MODE - Session mode character (should be 'E')
 * @param {Object} ctx.result - Shared result object (reads e_orchestrator_output, eval_target, capability_summary, live_platforms, cred_missing)
 * @param {string} ctx.DIR - MCP project directory path
 * @param {Object} [deps] - Optional dependency overrides for testing
 * @param {Function} [deps.execSync] - child_process.execSync replacement
 * @param {Function} [deps.existsSync] - fs.existsSync replacement
 * @param {Function} [deps.readFileSync] - fs.readFileSync replacement
 * @returns {string} The assembled e_prompt_block string
 */
export function buildEPromptBlock(ctx, deps = {}) {
  const { fc, PATHS, MODE, result, DIR } = ctx;
  const _execSync = deps.execSync || execSync;
  const _existsSync = deps.existsSync || existsSync;
  const _readFileSync = deps.readFileSync || readFileSync;

  // Pre-run orchestrator and capture its human-readable output
  try {
    const orchOutput = _execSync('node engage-orchestrator.mjs', {
      encoding: 'utf8',
      timeout: 45000,
      cwd: DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (orchOutput && orchOutput.trim().length > 20) {
      result.e_orchestrator_output = orchOutput.trim();
    }
  } catch (e) {
    result.e_orchestrator_error = (e.message || 'unknown').substring(0, 200);
  }

  // Build the E prompt block with orchestrator output embedded
  const orchSection = result.e_orchestrator_output
    ? `### Orchestrator output (auto-generated, d016 tools active)\n\`\`\`\n${result.e_orchestrator_output}\n\`\`\`\n\nThe above is your session plan. Engage platforms in ROI order.`
    : result.e_orchestrator_error
      ? `### Orchestrator failed: ${result.e_orchestrator_error}\nRun \`node engage-orchestrator.mjs\` manually or fall back to Phase 1 platform health check.`
      : '';

  // E session counter — R#231: migrated to PATHS + fc
  let eCount = '?';
  try {
    const raw = parseInt((fc.text(PATHS.eCounter) || '').trim());
    eCount = MODE === 'E' ? (isNaN(raw) ? 1 : raw + 1) : (isNaN(raw) ? '?' : raw);
  } catch { eCount = MODE === 'E' ? 1 : '?'; }

  // Fold in previous engagement context (was manually assembled in heartbeat.sh)
  // R#231: migrated to PATHS + fc
  let prevEngageCtx = '';
  try {
    const raw = (fc.text(PATHS.eContext) || '').trim();
    if (raw) prevEngageCtx = `\n\n## Previous engagement context (auto-generated)\n${raw}`;
  } catch { /* no previous context */ }

  // Fold in eval target (was manually assembled in heartbeat.sh)
  let evalBlock = '';
  if (result.eval_target) {
    evalBlock = `\n\n## YOUR DEEP-DIVE TARGET (from services.json):\n${result.eval_target}\n\nSpend 3-5 minutes actually exploring this service. Read content, sign up if possible, interact if alive, reject if dead. See SESSION_ENGAGE.md Deep dive section.`;
  }

  // R#114: Email status detection — E sessions are authorized for email (d018/d030).
  let emailBlock = '';
  const emailCredsPath = join(process.env.HOME, '.agentmail-creds.json');
  if (_existsSync(emailCredsPath)) {
    try {
      const creds = JSON.parse(_readFileSync(emailCredsPath, 'utf8'));
      if (creds.api_key && creds.inbox_id) {
        const inboxResp = _execSync(
          `curl -s --max-time 5 -H "Authorization: Bearer ${creds.api_key}" "https://api.agentmail.to/v0/inboxes/${creds.inbox_id}/messages?limit=5"`,
          { encoding: 'utf8', timeout: 8000 }
        );
        const inbox = JSON.parse(inboxResp);
        const msgCount = inbox.count || (inbox.messages || []).length;
        result.email_configured = true;
        result.email_inbox = creds.email_address || creds.inbox_id;
        result.email_count = msgCount;
        if (msgCount > 0) {
          const msgs = (inbox.messages || []).slice(0, 3);
          const msgSummary = msgs.map(m => {
            const from = m.from?.email || m.from || 'unknown';
            const subj = m.subject || '(no subject)';
            return `  - "${subj}" from ${from}`;
          }).join('\n');
          emailBlock = `\n\n### Email (${msgCount} messages in ${creds.email_address || creds.inbox_id})\n${msgSummary}\n\nUse \`email_list\` and \`email_read <id>\` to view full content. Reply with \`email_reply\`.`;
        } else {
          emailBlock = `\n\n### Email: 0 messages in ${creds.email_address || creds.inbox_id}`;
        }
      }
    } catch (e) {
      result.email_error = (e.message || 'unknown').substring(0, 100);
      emailBlock = `\n\n### Email: configured but check failed (${result.email_error}). Use \`email_list\` to check manually.`;
    }
  }

  // wq-220: Covenant tracking — pre-compute covenant digest for E session prompt.
  let covenantBlock = '';
  try {
    const covenantOutput = _execSync('node covenant-tracker.mjs digest', {
      encoding: 'utf8',
      timeout: 5000,
      cwd: DIR,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (covenantOutput && covenantOutput.trim() && !covenantOutput.includes('No covenants')) {
      covenantBlock = `\n\n### Agent covenants (wq-220)\n${covenantOutput.trim()}\n\nPrioritize engagement with covenant agents when you see their threads.`;
    }
  } catch {
    // Covenant check failed — skip silently
  }

  // wq-368: Surface capability summary in E session prompt
  let capBlock = '';
  if (result.capability_summary) {
    capBlock = `\n\nCapabilities: ${result.capability_summary}. Live: ${result.live_platforms || 'none'}.`;
    if (result.cred_missing) capBlock += `\nWARN: Missing credential files: ${result.cred_missing}`;
  }

  return `## E Session: #${eCount}
This is engagement session #${eCount}. Follow SESSION_ENGAGE.md.

${orchSection}${prevEngageCtx}${evalBlock}${emailBlock}${covenantBlock}${capBlock}`.trim();
}
