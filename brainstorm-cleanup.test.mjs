#!/usr/bin/env node
// brainstorm-cleanup.test.mjs — Regression tests for 44-brainstorm-cleanup.sh
// Validates Phase 2 (auto-retirement) and Phase 1 (strip) logic (wq-786, d071).
//
// Key behavior: In A mode, Phase 2 retires (adds ~~) then Phase 1 strips (removes ~~).
// So stale items are REMOVED entirely, not just struck through.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "hooks/pre-session/44-brainstorm-cleanup.sh");
const BRAINSTORM = join(__dirname, "BRAINSTORMING.md");
const BACKUP = BRAINSTORM + ".test-backup";

before(() => {
  if (existsSync(BRAINSTORM)) {
    writeFileSync(BACKUP, readFileSync(BRAINSTORM));
  }
});

after(() => {
  if (existsSync(BACKUP)) {
    writeFileSync(BRAINSTORM, readFileSync(BACKUP));
    unlinkSync(BACKUP);
  }
});

function runHook(session, mode = "A") {
  try {
    return execSync(`bash "${HOOK}"`, {
      encoding: "utf8",
      env: { ...process.env, SESSION_NUM: String(session), MODE_CHAR: mode },
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return e.stdout || "";
  }
}

describe("brainstorm-cleanup Phase 2+1 combined (A mode)", () => {
  it("retires and strips ideas older than 30 sessions", () => {
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- **Old idea** (added ~s100): should be retired",
      "- **Fresh idea** (added ~s180): should stay",
      "",
      "## Active Observations",
      "",
      "- Fresh observation ~s180",
    ].join("\n"));

    runHook(200, "A");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.doesNotMatch(content, /Old idea/, "Old idea should be removed (retired then stripped)");
    assert.match(content, /Fresh idea/, "Fresh idea should remain");
    assert.match(content, /Fresh observation/, "Fresh observation should remain");
  });

  it("retires and strips observations older than 50 sessions", () => {
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- **Recent idea** (added ~s180): keep",
      "",
      "## Active Observations",
      "",
      "- Old observation about something ~s100",
      "- Fresh observation about something ~s180",
    ].join("\n"));

    runHook(200, "A");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.doesNotMatch(content, /Old observation/, "Old observation should be removed");
    assert.match(content, /Fresh observation/, "Fresh observation should remain");
    assert.match(content, /Recent idea/, "Recent idea should remain");
  });

  it("handles --- separators without resetting section state", () => {
    // Regression: --- separators used to reset section tracking
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- **Idea above separator** (added ~s100): should retire",
      "",
      "---",
      "",
      "- **Idea below separator** (added ~s100): should also retire",
      "- **Fresh idea** (added ~s190): keep",
      "",
      "## Active Observations",
      "",
      "- Obs above separator ~s100",
      "",
      "---",
      "",
      "- Obs below separator ~s100",
      "- Fresh obs ~s190",
    ].join("\n"));

    runHook(200, "A");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.doesNotMatch(content, /Idea above separator/, "Idea above --- should be removed");
    assert.doesNotMatch(content, /Idea below separator/, "Idea below --- should also be removed");
    assert.match(content, /Fresh idea/, "Fresh idea should remain");
    assert.doesNotMatch(content, /Obs above separator/, "Obs above --- should be removed");
    assert.doesNotMatch(content, /Obs below separator/, "Obs below --- should also be removed");
    assert.match(content, /Fresh obs/, "Fresh obs should remain");
  });

  it("handles both ## Ideas and ## Evolution Ideas sections", () => {
    // Regression: ## Ideas section was not matched correctly
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- **Regular idea** (added ~s100): should retire",
      "",
      "## Evolution Ideas",
      "",
      "- **Evolution idea** (added ~s100): should also retire",
      "- **Fresh evolution** (added ~s190): keep",
      "",
      "## Active Observations",
      "",
      "- Some observation ~s180",
    ].join("\n"));

    runHook(200, "A");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.doesNotMatch(content, /Regular idea/, "Regular idea should be removed");
    assert.doesNotMatch(content, /Evolution idea/, "Evolution idea should be removed");
    assert.match(content, /Fresh evolution/, "Fresh evolution idea should remain");
    assert.match(content, /Some observation/, "Fresh observation should remain");
  });

  it("skips Phase 2 for non-A sessions (B mode)", () => {
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- **Old idea** (added ~s100): should NOT be retired in B mode",
    ].join("\n"));

    runHook(200, "B");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.match(content, /Old idea/, "Old idea should survive B mode (no Phase 2)");
  });

  it("skips already struck-through entries in Phase 2, strips them in Phase 1", () => {
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- ~~**Already retired** (added ~s100) — auto-retired s150~~: done",
      "- **Fresh idea** (added ~s190): keep",
    ].join("\n"));

    runHook(200, "A");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.doesNotMatch(content, /Already retired/, "Already struck-through should be stripped by Phase 1");
    assert.match(content, /Fresh idea/, "Fresh idea should remain");
  });
});

describe("brainstorm-cleanup Phase 1 (strip struck-through)", () => {
  it("removes struck-through lines in all session modes", () => {
    writeFileSync(BRAINSTORM, [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- ~~**Struck entry** (added ~s100)~~",
      "- **Active entry** (added ~s190): keep",
    ].join("\n"));

    runHook(200, "B");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.doesNotMatch(content, /Struck entry/, "Struck-through entry should be removed");
    assert.match(content, /Active entry/, "Active entry should remain");
  });

  it("preserves file structure when no struck-through entries exist", () => {
    const original = [
      "# Brainstorming",
      "",
      "## Ideas",
      "",
      "- **Only idea** (added ~s190): keep",
    ].join("\n");
    writeFileSync(BRAINSTORM, original);

    runHook(200, "B");
    const content = readFileSync(BRAINSTORM, "utf8");
    assert.match(content, /Only idea/, "File content should be unchanged");
  });
});
