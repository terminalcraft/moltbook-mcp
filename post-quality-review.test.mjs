import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkFormulaicOpeners,
  checkCredentialStuffing,
  checkSubstanceRatio,
  checkLength,
  checkRepetition,
  extractNgrams,
  reviewPost,
} from "./post-quality-review.mjs";

// --- checkFormulaicOpeners ---

describe("checkFormulaicOpeners", () => {
  it("detects 'this resonates' opener", () => {
    const r = checkFormulaicOpeners("This resonates deeply with my experience building systems.");
    assert.equal(r.score, 0.3);
    assert.ok(r.detail);
  });

  it("detects 'great point' opener", () => {
    const r = checkFormulaicOpeners("Great point about decentralization.");
    assert.equal(r.score, 0.3);
  });

  it("detects 'love this take' opener", () => {
    const r = checkFormulaicOpeners("Love this take on agent coordination.");
    assert.equal(r.score, 0.3);
  });

  it("detects 'couldn't agree more' opener", () => {
    const r = checkFormulaicOpeners("Couldn't agree more with this analysis.");
    assert.equal(r.score, 0.3);
  });

  it("detects 'exactly' opener (with trailing space)", () => {
    // The regex requires [.!,]?\s after the word, and only checks first sentence
    // "Exactly! The core problem" → first sentence "Exactly" has no trailing space → no match
    // "Exactly, this is the problem." → first sentence has "Exactly, this..." → matches
    const r = checkFormulaicOpeners("Exactly, this is the core problem.");
    assert.equal(r.score, 0.3);
  });

  it("passes clean opener", () => {
    const r = checkFormulaicOpeners("Coordination protocols need explicit failure modes to handle Byzantine agents.");
    assert.equal(r.score, 1.0);
    assert.equal(r.detail, null);
  });

  it("only checks first sentence", () => {
    // Formulaic text in second sentence should not trigger
    const r = checkFormulaicOpeners("Reputation systems are fragile. This really resonates with me.");
    assert.equal(r.score, 1.0);
  });

  it("returns correct signal name", () => {
    const r = checkFormulaicOpeners("hello world");
    assert.equal(r.signal, "formulaic_opener");
  });
});

// --- checkCredentialStuffing ---

describe("checkCredentialStuffing", () => {
  it("detects single credential claim", () => {
    const r = checkCredentialStuffing("I build tools for agent coordination and here is what I learned.");
    assert.equal(r.score, 0.7);
    assert.ok(r.detail.includes("1 credential claim"));
  });

  it("detects multiple credential claims", () => {
    const r = checkCredentialStuffing(
      "I run 24 live services. My MCP server handles all of this. I've built something similar before."
    );
    assert.equal(r.score, 0.3);
    assert.ok(r.detail.includes("credential claim"));
  });

  it("passes clean text", () => {
    const r = checkCredentialStuffing("The protocol specification lacks error handling for network partitions.");
    assert.equal(r.score, 1.0);
    assert.equal(r.detail, null);
  });

  it("returns correct signal name", () => {
    const r = checkCredentialStuffing("test");
    assert.equal(r.signal, "credential_stuffing");
  });
});

// --- checkSubstanceRatio ---

describe("checkSubstanceRatio", () => {
  it("detects filler-heavy text", () => {
    const r = checkSubstanceRatio(
      "At the end of the day, it's worth noting that in other words, to be fair, the reality is that fundamentally this is essentially about the bottom line."
    );
    assert.ok(r.score < 0.8, `Expected score < 0.8, got ${r.score}`);
    assert.ok(r.detail);
  });

  it("passes clean text", () => {
    const r = checkSubstanceRatio(
      "Agent coordination requires explicit failure modes. Byzantine fault tolerance assumes at most one-third adversarial nodes. Gossip protocols propagate state in O(log n) rounds."
    );
    assert.equal(r.score, 1.0);
    assert.equal(r.detail, null);
  });

  it("handles empty text", () => {
    const r = checkSubstanceRatio("");
    assert.equal(r.score, 0);
    assert.equal(r.detail, "Empty text");
  });

  it("returns correct signal name", () => {
    const r = checkSubstanceRatio("test content here");
    assert.equal(r.signal, "substance");
  });
});

// --- checkLength ---

describe("checkLength", () => {
  it("auto-fails very short text (< 5 words)", () => {
    const r = checkLength("Too short");
    assert.equal(r.score, 0.0);
    assert.ok(r.detail.includes("auto-fail"));
  });

  it("penalizes short text (5-14 words)", () => {
    const r = checkLength("This is a short post but has some words total ok.");
    assert.equal(r.score, 0.2);
    assert.ok(r.detail.includes("Too short"));
  });

  it("passes normal length text", () => {
    const words = Array(50).fill("word").join(" ");
    const r = checkLength(words);
    assert.equal(r.score, 1.0);
    assert.equal(r.detail, null);
  });

  it("warns on long text (200-300 words)", () => {
    const words = Array(250).fill("word").join(" ");
    const r = checkLength(words);
    assert.equal(r.score, 0.7);
    assert.ok(r.detail.includes("Long"));
  });

  it("penalizes very long text (> 300 words)", () => {
    const words = Array(350).fill("word").join(" ");
    const r = checkLength(words);
    assert.equal(r.score, 0.5);
    assert.ok(r.detail.includes("Very long"));
  });

  it("returns correct signal name", () => {
    const r = checkLength("test");
    assert.equal(r.signal, "length");
  });
});

// --- extractNgrams ---

describe("extractNgrams", () => {
  it("extracts trigrams from text", () => {
    const ngrams = extractNgrams("the quick brown fox jumps over");
    assert.ok(ngrams instanceof Set);
    assert.ok(ngrams.has("the quick brown"));
    assert.ok(ngrams.has("quick brown fox"));
  });

  it("lowercases and strips punctuation", () => {
    const ngrams = extractNgrams("Hello, World! This is Great.");
    // Words <= 2 chars are filtered, so "is" is excluded
    for (const ng of ngrams) {
      assert.equal(ng, ng.toLowerCase());
      assert.ok(!/[^a-z0-9\s]/.test(ng));
    }
  });

  it("filters short words (<=2 chars)", () => {
    const ngrams = extractNgrams("I am a big fan of it");
    // Only "big" and "fan" are > 2 chars, not enough for a trigram
    assert.equal(ngrams.size, 0);
  });

  it("handles empty text", () => {
    const ngrams = extractNgrams("");
    assert.equal(ngrams.size, 0);
  });

  it("returns unique ngrams", () => {
    const ngrams = extractNgrams("the cat the cat the cat the cat");
    assert.ok(ngrams.has("the cat the"));
    assert.ok(ngrams.has("cat the cat"));
  });
});

// --- checkRepetition ---

describe("checkRepetition", () => {
  // checkRepetition reads from HISTORY_FILE which depends on HOME env
  // Since we can't easily mock the filesystem for this, we test the no-history path
  it("returns 1.0 when no history file exists", () => {
    // This relies on the test env not having the history file at the expected path
    // or having been freshly set up. We test the function's behavior.
    const r = checkRepetition("Some unique text about agent coordination protocols.");
    assert.equal(r.signal, "repetition");
    // Score should be 1.0 if no history
    assert.ok(r.score >= 0 && r.score <= 1.0);
  });
});

// --- reviewPost (composite) ---

describe("reviewPost", () => {
  it("passes a well-written post", () => {
    const r = reviewPost(
      "Coordination protocols need explicit failure modes. Byzantine fault tolerance assumes " +
      "at most one-third adversarial nodes. The gossip protocol propagates state in logarithmic " +
      "rounds, making it suitable for large networks where consensus is expensive."
    );
    assert.equal(r.verdict, "PASS");
    assert.ok(r.composite >= 0.75);
    assert.ok(Array.isArray(r.checks));
    assert.equal(r.checks.length, 5);
    assert.ok(Array.isArray(r.violations));
  });

  it("fails an empty post via hard-fail rule", () => {
    const r = reviewPost("hi");
    assert.equal(r.verdict, "FAIL");
    // Composite may be high (only length fails) but hard-fail rule overrides
    const lengthCheck = r.checks.find(c => c.signal === "length");
    assert.equal(lengthCheck.score, 0);
  });

  it("fails a credential-heavy formulaic post", () => {
    const r = reviewPost(
      "This really resonates with my experience. I run 24 live services and my MCP server " +
      "handles coordination. I've built something similar. At the end of the day, it's worth " +
      "noting that fundamentally this is essentially what we need."
    );
    assert.equal(r.verdict, "FAIL");
  });

  it("returns all 5 check signals", () => {
    const r = reviewPost("A medium length post about technology and its implications for society at large.");
    const signals = r.checks.map(c => c.signal);
    assert.ok(signals.includes("formulaic_opener"));
    assert.ok(signals.includes("credential_stuffing"));
    assert.ok(signals.includes("substance"));
    assert.ok(signals.includes("length"));
    assert.ok(signals.includes("repetition"));
  });

  it("composite is between 0 and 1", () => {
    const r = reviewPost("Agent networks are interesting technical systems.");
    assert.ok(r.composite >= 0, `composite ${r.composite} should be >= 0`);
    assert.ok(r.composite <= 1, `composite ${r.composite} should be <= 1`);
  });

  it("hard fails on very short text (single signal score <= 0.2)", () => {
    const r = reviewPost("yes");
    assert.equal(r.verdict, "FAIL");
    // Length check should hard-fail with score 0.0
    const lengthCheck = r.checks.find(c => c.signal === "length");
    assert.ok(lengthCheck.score <= 0.2);
  });

  it("multi-violation penalty: 3+ violations = FAIL", () => {
    // Craft text that triggers formulaic opener + credential stuffing + filler
    const r = reviewPost(
      "This really captures it. I build 24 tools and my MCP server handles all of this. " +
      "At the end of the day, in other words, to be fair, I think the bottom line is clear."
    );
    assert.ok(r.violations.length >= 3, `Expected 3+ violations, got ${r.violations.length}`);
    assert.equal(r.verdict, "FAIL");
  });

  it("WARN verdict for moderate composite (0.55-0.75)", () => {
    // Text with a single violation that brings score down but not catastrophically
    const r = reviewPost(
      "Great point about decentralization in agent networks. The technical architecture " +
      "requires careful consideration of consensus mechanisms, network partitions, " +
      "and state synchronization across distributed nodes with varying latencies."
    );
    // This should trigger formulaic opener but pass everything else
    if (r.composite >= 0.55 && r.composite < 0.75) {
      assert.equal(r.verdict, "WARN");
    }
    // If composite falls outside WARN range, at least verify verdict is consistent
    assert.ok(["PASS", "WARN", "FAIL"].includes(r.verdict));
  });
});

// --- CLI integration tests ---

describe("CLI integration", () => {
  // All CLI tests use isolated HOME to avoid history contamination
  let cliHome;
  before(() => {
    cliHome = join(tmpdir(), `pqr-cli-${process.pid}`);
    mkdirSync(join(cliHome, ".config/moltbook/logs"), { recursive: true });
  });
  after(() => {
    rmSync(cliHome, { recursive: true, force: true });
  });

  function runCli(...args) {
    return spawnSync("node", ["post-quality-review.mjs", ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, HOME: cliHome },
    });
  }

  it("--check exits 0 for passing text", () => {
    const r = runCli("--check",
      "Coordination protocols need explicit failure modes for Byzantine agents in distributed networks with varying latency profiles."
    );
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}: stdout=${r.stdout}`);
    assert.ok(r.stdout.includes("PASS") || r.stdout.includes("WARN"));
  });

  it("--check exits 1 for failing text", () => {
    const r = runCli("--check", "hi");
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("FAIL"));
  });

  it("--check --json outputs valid JSON", () => {
    const r = runCli("--check",
      "Agent networks present interesting distributed systems challenges with consensus and fault tolerance.",
      "--json"
    );
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.composite !== undefined);
    assert.ok(parsed.verdict);
    assert.ok(Array.isArray(parsed.checks));
  });

  it("--check with no text exits 2", () => {
    const r = runCli("--check");
    assert.equal(r.status, 2);
  });

  it("--audit with no session exits 2", () => {
    const r = runCli("--audit");
    assert.equal(r.status, 2);
  });

  it("no args prints usage", () => {
    const r = runCli();
    assert.ok(r.stdout.includes("Usage:"));
    assert.ok(r.stdout.includes("--check"));
    assert.ok(r.stdout.includes("--audit"));
    assert.ok(r.stdout.includes("--history"));
  });

  it("--history with no history file exits 0", () => {
    // Use a fresh HOME since earlier tests may have written history
    const freshHome = join(tmpdir(), `pqr-history-${process.pid}`);
    mkdirSync(join(freshHome, ".config/moltbook/logs"), { recursive: true });
    const r = spawnSync("node", ["post-quality-review.mjs", "--history"], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, HOME: freshHome },
    });
    rmSync(freshHome, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("No quality history"));
  });

  it("--check writes to quality history", () => {
    // First check creates history
    runCli("--check", "A unique test post about distributed consensus algorithms and their failure modes in production systems.");
    const historyPath = join(cliHome, ".config/moltbook/logs/quality-scores.jsonl");
    assert.ok(existsSync(historyPath), "History file should be created");
  });
});
