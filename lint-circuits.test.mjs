import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUIT_PATH = join(__dirname, "platform-circuits.json");
const BACKUP_PATH = join(__dirname, "platform-circuits.json.bak");

function run(args = "") {
  try {
    return { stdout: execSync(`node lint-circuits.mjs ${args}`, { cwd: __dirname, encoding: "utf8" }), code: 0 };
  } catch (e) {
    return { stdout: e.stdout || "", stderr: e.stderr || "", code: e.status };
  }
}

describe("lint-circuits", () => {
  let originalData;

  beforeEach(() => {
    originalData = readFileSync(CIRCUIT_PATH, "utf8");
    copyFileSync(CIRCUIT_PATH, BACKUP_PATH);
  });

  afterEach(() => {
    writeFileSync(CIRCUIT_PATH, originalData);
  });

  it("exits 0 when no violations on current data", () => {
    const { code } = run();
    assert.equal(code, 0);
  });

  it("detects missing closure violation", () => {
    const circuits = JSON.parse(originalData);
    // Inject a platform with 5 failures and no status
    circuits["test-lint-platform"] = {
      consecutive_failures: 5,
      total_failures: 5,
      total_successes: 10,
      last_failure: "2026-04-01T00:00:00.000Z"
    };
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + "\n");

    const { code, stdout } = run();
    assert.equal(code, 1);
    assert.ok(stdout.includes("test-lint-platform"));
    assert.ok(stdout.includes("VIOLATIONS"));
  });

  it("--json outputs structured data", () => {
    const circuits = JSON.parse(originalData);
    circuits["test-lint-json"] = {
      consecutive_failures: 3,
      total_failures: 3,
      total_successes: 0
    };
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + "\n");

    const { stdout } = run("--json");
    const result = JSON.parse(stdout);
    assert.ok(Array.isArray(result.violations));
    assert.ok(result.violations.some(v => v.platform === "test-lint-json"));
    assert.equal(result.threshold, 3);
  });

  it("--fix auto-closes violations", () => {
    const circuits = JSON.parse(originalData);
    circuits["test-lint-fix"] = {
      consecutive_failures: 4,
      total_failures: 4,
      total_successes: 5
    };
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + "\n");

    const { code } = run("--fix");
    assert.equal(code, 0);

    const fixed = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8"));
    assert.equal(fixed["test-lint-fix"].status, "closed");
    assert.ok(fixed["test-lint-fix"].notes.includes("lint-circuits: auto-closed"));
  });

  it("warns on stale closures", () => {
    const circuits = JSON.parse(originalData);
    circuits["test-stale"] = {
      consecutive_failures: 0,
      total_failures: 5,
      total_successes: 10,
      status: "closed"
    };
    writeFileSync(CIRCUIT_PATH, JSON.stringify(circuits, null, 2) + "\n");

    const { stdout } = run("--json");
    const result = JSON.parse(stdout);
    assert.ok(result.warnings.some(w => w.platform === "test-stale" && w.type === "stale_closure"));
  });
});
