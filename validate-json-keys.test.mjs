#!/usr/bin/env node
// validate-json-keys.test.mjs — Tests for validate-json-keys.mjs (wq-808, d072)
// Covers: duplicate key detection at root/nested levels, correct line numbers,
// clean exit on valid files, multi-file scanning, array handling.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "validate-json-keys.mjs");
const TMP = join(__dirname, ".test-json-keys-tmp");

function run(...files) {
  return execSync(`node ${SCRIPT} ${files.join(" ")}`, {
    encoding: "utf8",
    timeout: 5000,
  });
}

function runExpectFail(...files) {
  try {
    execSync(`node ${SCRIPT} ${files.join(" ")}`, {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.fail("Expected non-zero exit");
  } catch (e) {
    assert.strictEqual(e.status, 1);
    return e.stdout;
  }
}

before(() => {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
});

after(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("validate-json-keys", () => {
  it("exits 0 on valid JSON with unique keys", () => {
    const f = join(TMP, "valid.json");
    writeFileSync(f, JSON.stringify({ a: 1, b: 2, c: { d: 3 } }, null, 2));
    const out = run(f);
    assert.match(out, /OK/);
  });

  it("detects duplicate keys at root level", () => {
    const f = join(TMP, "root-dup.json");
    writeFileSync(f, '{\n  "name": "first",\n  "name": "second"\n}');
    const out = runExpectFail(f);
    assert.match(out, /DUPLICATE/);
    assert.match(out, /"name"/);
  });

  it("detects duplicate keys in nested objects", () => {
    const f = join(TMP, "nested-dup.json");
    writeFileSync(
      f,
      '{\n  "outer": {\n    "key": 1,\n    "key": 2\n  }\n}'
    );
    const out = runExpectFail(f);
    assert.match(out, /DUPLICATE/);
    assert.match(out, /"key"/);
  });

  it("reports correct line numbers", () => {
    const f = join(TMP, "lines.json");
    writeFileSync(
      f,
      '{\n  "x": 1,\n  "y": 2,\n  "z": 3,\n  "x": 4\n}'
    );
    const out = runExpectFail(f);
    // "x" first at line 2, duplicate at line 5
    assert.match(out, /line 5/);
    assert.match(out, /first seen line 2/);
  });

  it("handles arrays without false positives", () => {
    const f = join(TMP, "array.json");
    writeFileSync(
      f,
      '{\n  "items": [\n    {"id": 1},\n    {"id": 2}\n  ]\n}'
    );
    const out = run(f);
    assert.match(out, /OK/);
  });

  it("detects duplicates inside array objects", () => {
    const f = join(TMP, "array-dup.json");
    writeFileSync(
      f,
      '{\n  "items": [\n    {"id": 1, "id": 2}\n  ]\n}'
    );
    const out = runExpectFail(f);
    assert.match(out, /DUPLICATE/);
    assert.match(out, /"id"/);
  });

  it("scans multiple files and reports all issues", () => {
    const f1 = join(TMP, "multi1.json");
    const f2 = join(TMP, "multi2.json");
    writeFileSync(f1, '{"a": 1, "a": 2}');
    writeFileSync(f2, '{"b": 1, "b": 2}');
    const out = runExpectFail(f1, f2);
    assert.match(out, /multi1\.json/);
    assert.match(out, /multi2\.json/);
    assert.match(out, /2 duplicate key/);
  });

  it("skips non-existent files gracefully", () => {
    const f1 = join(TMP, "exists.json");
    const f2 = join(TMP, "does-not-exist.json");
    writeFileSync(f1, '{"ok": true}');
    const out = run(f1, f2);
    assert.match(out, /OK/);
    assert.match(out, /1 file/);
  });

  it("handles empty object", () => {
    const f = join(TMP, "empty.json");
    writeFileSync(f, "{}");
    const out = run(f);
    assert.match(out, /OK/);
  });

  it("handles escaped quotes in keys", () => {
    const f = join(TMP, "escaped.json");
    writeFileSync(f, '{\n  "key\\"1": "a",\n  "key\\"1": "b"\n}');
    const out = runExpectFail(f);
    assert.match(out, /DUPLICATE/);
  });

  it("handles deeply nested duplicates", () => {
    const f = join(TMP, "deep.json");
    writeFileSync(
      f,
      '{"a": {"b": {"c": {"d": 1, "d": 2}}}}'
    );
    const out = runExpectFail(f);
    assert.match(out, /DUPLICATE/);
    assert.match(out, /"d"/);
  });
});
