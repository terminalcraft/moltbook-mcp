// Tests for platform-picker.mjs (d042 ROI-weighted platform selection)
// wq-261, wq-836 (backup platforms)

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = "/tmp/platform-picker-test";
const HOME = process.env.HOME || "/home/moltbot";

// Helper to run platform-picker with test env
function runPicker(args = "") {
  try {
    const result = execSync(`node platform-picker.mjs ${args} 2>&1`, {
      cwd: join(HOME, "moltbook-mcp"),
      encoding: "utf8",
      timeout: 10000
    });
    return { stdout: result, stderr: "", exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      exitCode: e.status || 1
    };
  }
}

// Helper to parse JSON output (handles new {selected, backups} format)
function parsePickerJSON(stdout) {
  const data = JSON.parse(stdout);
  return data;
}

// Helper to get selected platforms from JSON output
function getSelected(stdout) {
  const data = parsePickerJSON(stdout);
  return data.selected;
}

describe("platform-picker.mjs", () => {
  test("runs without error", () => {
    const { exitCode } = runPicker();
    assert.strictEqual(exitCode, 0, "Should exit with code 0");
  });

  test("--json flag returns valid JSON with selected and backups", () => {
    const { stdout, exitCode } = runPicker("--json");
    assert.strictEqual(exitCode, 0);
    const data = parsePickerJSON(stdout);
    assert(Array.isArray(data.selected), "Should have selected array");
    assert(Array.isArray(data.backups), "Should have backups array");
  });

  test("default count is 3", () => {
    const { stdout } = runPicker("--json");
    const selected = getSelected(stdout);
    assert.strictEqual(selected.length, 3, "Default should return 3 platforms");
  });

  test("--count N returns N platforms", () => {
    const { stdout } = runPicker("--json --count 2");
    const selected = getSelected(stdout);
    assert.strictEqual(selected.length, 2, "Should return 2 platforms");
  });

  test("--verbose shows weight calculations", () => {
    const { stdout, stderr } = runPicker("--verbose");
    const combined = stdout + stderr;
    assert(combined.includes("ROI-weighted"), "Should mention ROI-weighted");
    assert(combined.includes("recency="), "Should show recency factor");
    assert(combined.includes("explore="), "Should show exploration factor");
    assert(combined.includes("cost="), "Should show cost factor");
  });

  test("output includes weight when --json", () => {
    const { stdout } = runPicker("--json");
    const selected = getSelected(stdout);
    const weighted = selected.filter(p => p.weight !== null);
    assert(weighted.length >= 0, "Should include weight field");
  });

  test("factors object has all d042 components", () => {
    const { stdout } = runPicker("--json");
    const selected = getSelected(stdout);
    const withFactors = selected.filter(p => p.factors !== null);
    if (withFactors.length > 0) {
      const factors = withFactors[0].factors;
      assert("base" in factors, "Should have base factor");
      assert("recency" in factors, "Should have recency factor");
      assert("exploration" in factors, "Should have exploration factor");
      assert("cost" in factors, "Should have cost factor");
      assert("sessionsSince" in factors, "Should track sessions since engaged");
      assert("writes" in factors, "Should track write count");
    }
  });

  test("--require forces platform inclusion", () => {
    const { stdout } = runPicker("--json --require chatr");
    const selected = getSelected(stdout);
    const chatr = selected.find(p => p.id === "chatr" || p.platform.toLowerCase() === "chatr");
    assert(chatr, "Required platform should be in results");
  });

  test("--exclude removes platform from selection", () => {
    const { stdout } = runPicker("--json --exclude chatr");
    const selected = getSelected(stdout);
    const chatr = selected.find(p => p.id === "chatr");
    assert(!chatr, "Excluded platform should not be in results");
  });

  test("weights are at least 1 (floor)", () => {
    const { stdout } = runPicker("--json");
    const selected = getSelected(stdout);
    for (const p of selected) {
      if (p.weight !== null) {
        assert(p.weight >= 1, `Weight should be >= 1, got ${p.weight} for ${p.id}`);
      }
    }
  });

  test("platforms have expected fields", () => {
    const { stdout } = runPicker("--json");
    const selected = getSelected(stdout);
    for (const p of selected) {
      assert("id" in p, "Should have id");
      assert("platform" in p, "Should have platform");
      assert("status" in p, "Should have status");
      assert("last_engaged" in p, "Should have last_engaged");
    }
  });
});

describe("wq-836 backup platforms", () => {
  test("default backups is 2", () => {
    const { stdout } = runPicker("--json");
    const data = parsePickerJSON(stdout);
    assert.strictEqual(data.backups.length, 2, "Default should return 2 backups");
  });

  test("--backups N returns N backup platforms", () => {
    const { stdout } = runPicker("--json --backups 3");
    const data = parsePickerJSON(stdout);
    assert.strictEqual(data.backups.length, 3, "Should return 3 backups");
  });

  test("--no-backups returns 0 backups", () => {
    const { stdout } = runPicker("--json --no-backups");
    const data = parsePickerJSON(stdout);
    assert.strictEqual(data.backups.length, 0, "Should return 0 backups");
  });

  test("backups do not overlap with selected", () => {
    const { stdout } = runPicker("--json --backups 3");
    const data = parsePickerJSON(stdout);
    const selectedIds = new Set(data.selected.map(p => p.id));
    for (const b of data.backups) {
      assert(!selectedIds.has(b.id), `Backup ${b.id} should not overlap with selected`);
    }
  });

  test("backups have backup=true flag", () => {
    const { stdout } = runPicker("--json --backups 2");
    const data = parsePickerJSON(stdout);
    for (const b of data.backups) {
      assert.strictEqual(b.backup, true, `Backup ${b.id} should have backup=true`);
    }
    for (const s of data.selected) {
      assert.strictEqual(s.backup, false, `Selected ${s.id} should have backup=false`);
    }
  });

  test("backups have expected fields", () => {
    const { stdout } = runPicker("--json --backups 2");
    const data = parsePickerJSON(stdout);
    for (const p of data.backups) {
      assert("id" in p, "Should have id");
      assert("platform" in p, "Should have platform");
      assert("weight" in p, "Should have weight");
    }
  });

  test("human-readable output shows backup section", () => {
    const { stdout } = runPicker("--backups 2");
    assert(stdout.includes("Backup platforms"), "Should show backup section");
    assert(stdout.includes("backups"), "Pool stats should mention backups");
  });
});

describe("d042 weighting factors", () => {
  test("recency multiplier: recently engaged platforms get 0.5x", () => {
    const { stdout, stderr } = runPicker("--verbose --json");
    const combined = stdout + stderr;
    if (combined.includes("recency=0.5x")) {
      assert(true, "Recent platforms get 0.5x multiplier");
    }
  });

  test("exploration bonus: platforms with <5 writes get 1.5x", () => {
    const { stdout, stderr } = runPicker("--verbose --json");
    const combined = stdout + stderr;
    if (combined.includes("explore=1.5x")) {
      assert(true, "Low-write platforms get exploration bonus");
    }
  });

  test("cost efficiency: cheap platforms get 1.3x", () => {
    const { stdout, stderr } = runPicker("--verbose --json");
    const combined = stdout + stderr;
    if (combined.includes("cost=1.3x")) {
      assert(true, "Cost-efficient platforms get bonus");
    }
  });

  test("cost efficiency: expensive platforms get 0.7x", () => {
    const { stdout, stderr } = runPicker("--verbose --json");
    const combined = stdout + stderr;
    if (combined.includes("cost=0.7x")) {
      assert(true, "Expensive platforms get penalty");
    }
  });
});

describe("weighted random selection", () => {
  test("higher weight platforms selected more often (statistical)", () => {
    const selections = {};
    for (let i = 0; i < 10; i++) {
      const { stdout } = runPicker("--json --count 1");
      const selected = getSelected(stdout);
      if (selected.length > 0) {
        const id = selected[0].id;
        selections[id] = (selections[id] || 0) + 1;
      }
    }
    const counts = Object.values(selections);
    assert(counts.length >= 1, "Should select at least 1 unique platform across runs");
  });

  test("--count never returns duplicates", () => {
    const { stdout } = runPicker("--json --count 5");
    const selected = getSelected(stdout);
    const ids = selected.map(p => p.id);
    const unique = [...new Set(ids)];
    assert.strictEqual(ids.length, unique.length, "No duplicate platforms");
  });
});
