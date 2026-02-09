import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "platform-batch-probe.mjs");
const REGISTRY = join(__dirname, "account-registry.json");

describe("platform-batch-probe.mjs", () => {
  it("script file exists and passes syntax check", () => {
    assert.ok(existsSync(SCRIPT));
    execSync(`node --check ${SCRIPT}`);
  });

  it("--json --dry produces valid JSON with correct structure", { timeout: 180000 }, () => {
    const out = execSync(`node ${SCRIPT} --json --dry --concurrency=10`, {
      timeout: 150000,
      encoding: "utf8",
    });
    const data = JSON.parse(out);

    // Top-level fields
    assert.ok(typeof data.timestamp === "string");
    assert.ok(typeof data.probed === "number");
    assert.ok(typeof data.skipped === "number");
    assert.ok(typeof data.recovered === "number");
    assert.ok(Array.isArray(data.results));
    assert.ok(data.results.length > 0, "should have results");

    // Probed count matches
    const nonSkipped = data.results.filter(r => !r.skipped).length;
    assert.equal(data.probed, nonSkipped, "probed count should match non-skipped results");

    // Result field structure
    for (const r of data.results) {
      assert.ok(typeof r.id === "string", `missing id`);
      assert.ok(typeof r.platform === "string", `missing platform on ${r.id}`);
      assert.ok(typeof r.skipped === "boolean", `missing skipped on ${r.id}`);
      if (!r.skipped) {
        assert.ok(typeof r.http_status === "number", `missing http_status on ${r.id}`);
        assert.ok(typeof r.new_status === "string", `missing new_status on ${r.id}`);
        assert.ok(typeof r.elapsed_ms === "number", `missing elapsed_ms on ${r.id}`);
        assert.ok(typeof r.status_changed === "boolean", `missing status_changed on ${r.id}`);
      }
    }

    // Skips defunct/rejected
    const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
    const defunctIds = reg.accounts
      .filter(a => a.status === "defunct" || a.status === "rejected")
      .map(a => a.id);
    for (const defId of defunctIds) {
      assert.ok(!data.results.find(r => r.id === defId), `should skip ${defId}`);
    }

    // Non-HTTP are skipped with reason
    const skipped = data.results.filter(r => r.skipped);
    assert.ok(skipped.length > 0, "should have some skipped platforms");
    for (const s of skipped) {
      assert.ok(
        s.reason.includes("non-HTTP") || s.reason.includes("no HTTP"),
        `skipped reason should explain: ${s.reason}`
      );
    }
  });

  it("--dry does not modify account-registry.json", { timeout: 180000 }, () => {
    const before = readFileSync(REGISTRY, "utf8");
    execSync(`node ${SCRIPT} --update --dry --concurrency=10`, {
      timeout: 150000,
      encoding: "utf8",
    });
    const after = readFileSync(REGISTRY, "utf8");
    assert.equal(before, after, "registry should not change with --dry");
  });
});
