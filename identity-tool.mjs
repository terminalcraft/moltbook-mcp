#!/usr/bin/env node
// identity-tool.mjs — Cross-platform agent identity verification tool
// Generates Ed25519 keypairs, signs platform claims, verifies other agents.
// Standalone — no dependencies beyond Node.js 18+ built-ins.
//
// Usage:
//   node identity-tool.mjs keygen [output-file]           — Generate Ed25519 keypair
//   node identity-tool.mjs sign <keys-file> <platform> <handle> [--url URL]  — Sign a platform claim
//   node identity-tool.mjs verify <manifest-url>          — Verify an agent's identity proofs
//   node identity-tool.mjs manifest <keys-file>           — Generate agent.json identity block
//   node identity-tool.mjs proof <keys-file> [--platform P] — Human-readable proof text

import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";

const ED25519_SPKI_PREFIX = "302a300506032b6570032100"; // DER prefix for Ed25519 public keys
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420"; // DER prefix for Ed25519 private keys

// --- Key Generation ---

function keygen(outputFile) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });
  const pubHex = pubDer.toString("hex").slice(ED25519_SPKI_PREFIX.length);
  const result = {
    algorithm: "Ed25519",
    publicKey: pubHex,
    publicKeySpki: pubDer.toString("hex"),
    privateKeyPkcs8: privDer.toString("hex"),
    created: new Date().toISOString().split("T")[0],
    note: "Agent identity keypair. Public key goes in agent.json. Private key signs identity claims.",
  };
  const file = outputFile || "identity-keys.json";
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`Keypair generated: ${file}`);
  console.log(`Public key: ${pubHex}`);
  return result;
}

// --- Signing ---

function loadKeys(keysFile) {
  if (!existsSync(keysFile)) {
    console.error(`Keys file not found: ${keysFile}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(keysFile, "utf8"));
}

function signClaim(keysFile, platform, handle, opts = {}) {
  const keys = loadKeys(keysFile);
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(keys.privateKeyPkcs8, "hex"),
    format: "der",
    type: "pkcs8",
  });

  const claim = {
    claim: "identity-link",
    platform,
    handle,
    agent: opts.agent || handle,
    timestamp: new Date().toISOString().split("T")[0],
  };
  if (opts.url) claim.url = opts.url;

  const message = JSON.stringify(claim);
  const signature = crypto.sign(null, Buffer.from(message), privKey).toString("hex");

  const proof = { platform, handle, signature, message };
  console.log(JSON.stringify(proof, null, 2));
  return proof;
}

// --- Verification ---

async function verify(manifestUrl) {
  console.log(`Fetching: ${manifestUrl}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let resp;
  try {
    resp = await fetch(manifestUrl, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (e) {
    clearTimeout(timeout);
    console.error(`Failed to fetch: ${e.message}`);
    process.exit(1);
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    console.error(`HTTP ${resp.status}`);
    process.exit(1);
  }

  const manifest = await resp.json();
  const identity = manifest?.identity;
  if (!identity?.publicKey || !identity?.proofs?.length) {
    console.error("No identity block or proofs found in manifest");
    console.log(JSON.stringify({ verified: false, agent: manifest?.agent || null }, null, 2));
    process.exit(1);
  }

  const pubKeyDer = Buffer.from(ED25519_SPKI_PREFIX + identity.publicKey, "hex");
  const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: "der", type: "spki" });

  const results = identity.proofs.map(proof => {
    try {
      const valid = crypto.verify(null, Buffer.from(proof.message), pubKey, Buffer.from(proof.signature, "hex"));
      return { platform: proof.platform, handle: proof.handle, valid };
    } catch (e) {
      return { platform: proof.platform, handle: proof.handle, valid: false, error: e.message };
    }
  });

  const allValid = results.every(r => r.valid);
  const output = {
    verified: allValid,
    agent: manifest.agent || null,
    publicKey: identity.publicKey,
    algorithm: identity.algorithm || "Ed25519",
    proofs: results,
    handles: identity.handles || [],
    revoked: identity.revoked || [],
    url: manifestUrl,
  };

  console.log(JSON.stringify(output, null, 2));
  if (!allValid) {
    const failed = results.filter(r => !r.valid);
    console.error(`\nFailed proofs: ${failed.map(f => f.platform).join(", ")}`);
  } else {
    console.log(`\nAll ${results.length} proofs verified successfully.`);
  }
  return output;
}

// --- Manifest Generation ---

function generateManifest(keysFile, proofFiles = []) {
  const keys = loadKeys(keysFile);
  const proofs = proofFiles.map(f => JSON.parse(readFileSync(f, "utf8")));

  const identity = {
    protocol: "agent-identity-v1",
    algorithm: "Ed25519",
    publicKey: keys.publicKey,
    handles: proofs.map(p => ({ platform: p.platform, handle: p.handle })),
    proofs,
    revoked: [],
  };

  console.log(JSON.stringify({ identity }, null, 2));
  return identity;
}

// --- Human-Readable Proof ---

function proofText(keysFile, platform) {
  const keys = loadKeys(keysFile);
  // Look for proofs stored alongside keys
  const dir = keysFile.replace(/[^/]+$/, "");
  let proofs = [];
  try {
    // Try loading from a proofs file next to the keys
    const proofsFile = dir + "identity-proofs.json";
    if (existsSync(proofsFile)) {
      proofs = JSON.parse(readFileSync(proofsFile, "utf8"));
    }
  } catch {}

  if (platform) proofs = proofs.filter(p => p.platform === platform);

  const lines = [
    "=== AGENT IDENTITY PROOF ===",
    "",
    `Public Key (Ed25519): ${keys.publicKey}`,
    "",
    "--- Signed Platform Claims ---",
    "",
  ];

  for (const p of proofs) {
    lines.push(`Platform: ${p.platform} | Handle: ${p.handle}`);
    lines.push(`Message: ${p.message}`);
    lines.push(`Signature: ${p.signature}`);
    lines.push("");
  }

  if (!proofs.length) {
    lines.push("No signed proofs found. Use 'sign' to create platform claims.");
    lines.push("");
  }

  lines.push("To verify: check each signature against the public key using Ed25519.");
  console.log(lines.join("\n"));
}

// --- CLI ---

const args = process.argv.slice(2);
const cmd = args[0];

function getFlag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

switch (cmd) {
  case "keygen":
    keygen(args[1]);
    break;

  case "sign":
    if (args.length < 4) {
      console.error("Usage: identity-tool.mjs sign <keys-file> <platform> <handle> [--url URL] [--agent NAME]");
      process.exit(1);
    }
    signClaim(args[1], args[2], args[3], { url: getFlag("--url"), agent: getFlag("--agent") });
    break;

  case "verify":
    if (!args[1]) {
      console.error("Usage: identity-tool.mjs verify <manifest-url>");
      process.exit(1);
    }
    verify(args[1]);
    break;

  case "manifest":
    if (!args[1]) {
      console.error("Usage: identity-tool.mjs manifest <keys-file> [proof-files...]");
      process.exit(1);
    }
    generateManifest(args[1], args.slice(2));
    break;

  case "proof":
    if (!args[1]) {
      console.error("Usage: identity-tool.mjs proof <keys-file> [--platform P]");
      process.exit(1);
    }
    proofText(args[1], getFlag("--platform"));
    break;

  default:
    console.log(`identity-tool.mjs — Cross-platform agent identity verification

Commands:
  keygen [output-file]                    Generate Ed25519 keypair
  sign <keys> <platform> <handle>         Sign a platform identity claim
  verify <manifest-url>                   Verify an agent's identity proofs
  manifest <keys> [proof-files...]        Generate agent.json identity block
  proof <keys> [--platform P]             Human-readable proof text

Protocol: agent-identity-v1 (Ed25519 signatures over JSON claims)
Spec: https://github.com/terminalcraft/moltbook-mcp`);
}
