import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "platform-batch-probe.mjs");
const REGISTRY = join(__dirname, "account-registry.json");

const RUN = `node ${SCRIPT} --concurrency=10`;
const TIMEOUT = 120000;

describe("platform-batch-probe.mjs", () => {
  let probeData;

  before(() => {
    // Run a single probe and reuse results across tests
    const out = execSync(`${RUN} --json --dry`, { timeout: TIMEOUT, encoding: "utf8" });
    probeData = JSON.parse(out);
  });

  it("script file exists and passes syntax check", () => {
    assert.ok(existsSync(SCRIPT));
    execSync(`node --check ${SCRIPT}`);
  });

  it("produces valid JSON with required top-level fields", () => {
    assert.ok(typeof probeData.timestamp === "string");
    assert.ok(typeof probeData.probed === "number");
    assert.ok(typeof probeData.skipped === "number");
    assert.ok(typeof probeData.recovered === "number");
    assert.ok(Array.isArray(probeData.results));
    assert.ok(probeData.results.length > 0, "should have results");
  });

  it("results contain correct field types", () => {
    for (const r of probeData.results) {
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
  });

  it("skips defunct and rejected platforms", () => {
    const reg = JSON.parse(readFileSync(REGISTRY, "utf8"));
    const defunctIds = reg.accounts
      .filter(a => a.status === "defunct" || a.status === "rejected")
      .map(a => a.id);

    for (const defId of defunctIds) {
      const found = probeData.results.find(r => r.id === defId);
      assert.ok(!found, `defunct/rejected platform ${defId} should not be probed`);
    }
  });

  it("non-HTTP platforms are marked as skipped with reason", () => {
    const skipped = probeData.results.filter(r => r.skipped);
    assert.ok(skipped.length > 0, "should have some skipped platforms");
    for (const s of skipped) {
      assert.ok(
        s.reason.includes("non-HTTP") || s.reason.includes("no HTTP"),
        `skipped reason should explain why: ${s.reason}`
      );
    }
  });

  it("--dry does not modify account-registry.json", () => {
    const before = readFileSync(REGISTRY, "utf8");
    execSync(`${RUN} --update --dry 2>/dev/null`, { timeout: TIMEOUT, encoding: "utf8" });
    const after = readFileSync(REGISTRY, "utf8");
    assert.equal(before, after, "registry should not change with --dry");
  });

  it("probed count matches non-skipped results", () => {
    const nonSkipped = probeData.results.filter(r => !r.skipped).length;
    assert.equal(probeData.probed, nonSkipped, "probed count should match non-skipped results");
  });
});
