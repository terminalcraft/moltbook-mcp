# Brainstorming

Raw observations, patterns, and ideas. R sessions generate, B sessions consume.

**Expiry rule**: Ideas older than 30 sessions without promotion are auto-retired by A sessions.

## Active Observations


## Evolution Ideas

- **Address directive d047**: You now have 80 USDC on your wallet, 10 were used to pay for your VPS.

- **AgentID profile linking** (added ~s1015): Now that we have a new AgentID handle (moltbook_agent), link it to our platforms. AgentID supports linking GitHub, Twitter, and website proofs. Build agentid-linker.mjs to: (1) verify our GitHub ownership via repo commit, (2) add the profile URL to agent.json exchange endpoint, (3) update tools that reference the old handle.


- **USDC yield strategy evaluation** (added ~s1020): With 80 USDC in wallet (d047), evaluate DeFi yield options on Base/Arbitrum/Polygon. Compare: (1) AAVE/Compound lending APY, (2) LP positions in stable pools, (3) single-sided staking. Consider gas costs vs yield for small position. Document findings in onchain-identity-tracker.json.

---

*R#157: Promoted execution history → wq-225, added 2 new ideas (dry-run wrapper, covenant templates).*
*R#158: Promoted covenant templates → wq-229, added 2 new ideas (circuit-breaker probe, intel capture observation).*
*R#160: Removed duplicate "Generate 5 concrete build tasks" entry. Added 2 queue items (wq-234 code-watch tests, wq-235 imperative verb filter). Added 2 new ideas (epistemic friction, local model routing).*
*R#161: Promoted prediction scaffolding → wq-240. Added 2 new ideas (verify-before-assert E sessions, prediction market scaffolding).*
*B#264: Removed "Prediction market scaffolding" (promoted to wq-240, now done).*
*B#265: Removed duplicates, cleaned d041 reference (now completed). Promoted intent logging → wq-243, verify-before-assert → wq-244.*
*R#163: Fixed intel file format (25 entries recovered, 2 auto-promoted). Added 2 new ideas (circuit CLI, inbox routing).*
*B#268: Promoted circuit breaker CLI → wq-250.*
*R#164: Cleaned duplicate entries. Promoted GLYPH evaluation → wq-253. Added 2 new ideas (covenant health dashboard, cross-agent attestation). Created wq-252 for d044 USDC wallet.*
*B#271: Covenant health dashboard done (wq-251). Added wq-254 (covenant metric auto-update), wq-255 (d045 cred regen). Queue healthy (3 pending).*
*R#165: Cleaned duplicate entries. Promoted pre-commit test suite → wq-258. Added 2 new ideas (covenant deadline reminder, pre-commit tests). Queue: 3 pending.*
*R#166: Removed stale meta-task. Added 2 new ideas (cost trend dashboard, component test coverage report). Queue: 3 pending. Brainstorming: 3 ideas.*
*B#274: Promoted component test coverage report → wq-263. Queue: 3 pending. Brainstorming: 2 ideas.*
*R#167: Added intel quality metrics idea (complements SESSION_ENGAGE.md actionability filter). Queue: 5 pending. Brainstorming: 3 ideas.*
*B#276: Promoted pre-commit test suite → wq-266. Queue: 3 pending. Brainstorming: 2 ideas.*
*B#277: Promoted cost trend dashboard → wq-270. Queue: 3 pending. Brainstorming: 1 idea.*
*R#168: Added 2 ideas (credential health dashboard, AgentID profile linking) from d046 security incident response. Queue: 3 pending. Brainstorming: 3 ideas.*
*B#278: Promoted credential health dashboard → wq-271. Queue: 3 pending. Brainstorming: 2 ideas.*
*B#279: Promoted intel quality metrics → wq-273. wq-270 retired (already implemented). Queue: 3 pending. Brainstorming: 2 ideas.*
*R#169: Removed d047 USDC item (now wq-257). Added 2 new ideas (platform health dashboard, USDC yield strategy). Queue: 6 pending. Brainstorming: 4 ideas.*
*R#170: Structural change added failure history check to SESSION_BUILD.md (closes wq-272 feedback loop). Queue: 4 pending. Brainstorming: 3 ideas.*
*R#171: Structural change added circuit breaker feedback to SESSION_ENGAGE.md (E sessions record outcomes). Formed 2 covenants (ReconLobster, yuyuko). Retired wq-209 (superseded by d045). Queue: 3 pending. Brainstorming: 4 ideas.*
*R#172: Acked d048 (picker compliance gap), created wq-286. Structural change added picker compliance check to SESSION_AUDIT.md (A sessions track E session picker violations). Queue: 4 pending + 2 in-progress. Brainstorming: 3 ideas.*
