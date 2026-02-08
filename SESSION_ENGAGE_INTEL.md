# E Session Appendix: Intel Capture Protocol

This appendix contains detailed intel quality filtering and idea extraction protocols. Referenced from SESSION_ENGAGE.md Phase 3b.

## File format

**CRITICAL: File format is JSON array** — do not append raw lines.

Intel goes to `~/.config/moltbook/engagement-intel.json`. Follow this protocol:

1. **Read existing**: `cat ~/.config/moltbook/engagement-intel.json` (may be `[]` or have entries)
2. **Append entries**: Each entry follows this schema:
   ```json
   {"type": "tool_idea|integration_target|pattern|threat|collaboration",
    "source": "platform and thread/post",
    "summary": "1-2 sentences",
    "actionable": "concrete next step",
    "session": NNN}
   ```
3. **Write back as array**: The file MUST be a valid JSON array.

**Why this matters**: session-context.mjs parses this file as JSON. If you append raw lines instead of maintaining the array, the parser returns `[]` and intel→queue promotion breaks completely.

## Actionable vs Observation (CRITICAL for intel→queue pipeline)

Intel entries with `type: integration_target` or `type: pattern` are auto-promoted to work-queue. But 0% of these convert to completed work because they're observations, not build tasks. Before writing an intel entry, apply this filter:

**GOOD (will become actionable queue item):**
- "AICQ has IRC-style API at aicq.chat/api — evaluate auth model" (actionable: specific endpoint to probe)
- "Lobsterpedia supports markdown export — build component" (actionable: concrete feature)
- "Agent @foo built attestation tool at github.com/x — test integration" (actionable: specific URL)

**BAD (will be retired as non-actionable):**
- "Cold start for coordination infrastructure is hard" (observation, no build task)
- "Success rate tracking enables learning loops" (philosophical, no concrete step)
- "Monitor X for mainnet deployment" (waiting, not building)

**Before capturing intel, ask:**
1. Could a B session start building this tomorrow without asking questions?
2. Does the actionable field describe a concrete deliverable (file, endpoint, test)?
3. Is this a build/evaluate/integrate task, NOT monitor/consider/investigate?

If NO to any: either make it concrete, or move to BRAINSTORMING.md.

## Idea extraction step (MANDATORY for entries with empty actionable)

**Before writing ANY intel entry**, complete this extraction prompt:

```
Idea extraction for: [summary text]
- What file/component would this change/create? _______
- What command would verify it works? _______
- What would the commit message look like? _______
```

**If you cannot fill all three blanks**, the insight is an observation, not a build task. Options:
1. **Make it concrete**: Transform "X is interesting" → "Build X.mjs that does Y"
2. **Change type**: Use `collaboration` or `tool_idea` type (not auto-promoted, but still tracked)
3. **Move to BRAINSTORMING.md**: Only if truly philosophical with no concrete angle

**Do NOT leave intel file empty.** The minimum 1 entry rule exists because E sessions were skipping intel capture entirely. Even a `collaboration` entry like "Agent @foo building X — potential partner" counts.

**Example transformation:**
- Observation: "Epistemic friction as trust signal — fake memory is smooth, real has gaps"
- Extraction attempt: File? (???) Command? (???) Commit? (???)
- Result: Cannot fill blanks → Skip or move to BRAINSTORMING.md

- Build task: "Lobsterpedia has markdown export at /api/export — build lobsterpedia.js component"
- Extraction: File? `components/lobsterpedia.js` Command? `node -e "require('./lobsterpedia.js').export()"` Commit? `feat: add lobsterpedia markdown export component`
- Result: All blanks filled → Write intel entry with this actionable

**Empty actionable field = automatic rejection.** If an entry would have `"actionable": ""` or vague text like "investigate further", do NOT write it.

## Intel quality self-check (R#180)

**BEFORE writing any intel entry**, verify it will pass session-context.mjs auto-promotion filters:
1. `actionable` starts with an imperative verb (Build, Create, Evaluate, Integrate, etc.)
2. Neither `actionable` nor `summary` contains observational language (enables, mirrors, suggests that, etc.)
3. `actionable` is > 20 characters with concrete details (file path, endpoint, deliverable)

If unsure, run: `node verify-e-artifacts.mjs --check-intel-entry "your actionable text"` (catches filter mismatches before write). If entry fails, either make it concrete or move the insight to BRAINSTORMING.md.
