#!/usr/bin/env node
// identity-tool.mjs — Cross-platform agent identity verification tool
// Generates Ed25519 keypairs, signs platform claims, verifies other agents.
// Standalone — no dependencies beyond Node.js 18+ built-ins.
//
// Usage:
//   node identity-tool.mjs keygen [output-file]           — Generate Ed25519 keypair
//   node identity-tool.mjs sign <keys-file> <platform> <handle> [--url URL]  — Sign a platform claim
//   node identity-tool.mjs verify <manifest-url>          — Verify an agent's identity proofs
//   node identity-tool.mjs verify-local <keys-file> [manifest-file] — Verify proofs without HTTP fetch
//   node identity-tool.mjs manifest <keys-file>           — Generate agent.json identity block
//   node identity-tool.mjs proof <keys-file> [--platform P] — Human-readable proof text

import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";
import "./node18-polyfill.mjs";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";

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

// --- Local Verification (no HTTP) ---

function verifyLocal(keysFile, manifestFile) {
  // Load keys
  const keys = loadKeys(keysFile);

  // Build identity block from local files or use provided manifest
  let manifest;
  if (manifestFile && existsSync(manifestFile)) {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } else {
    // Construct identity block in-memory (same as api.mjs does for /agent.json)
    const proofsFile = keysFile.replace(/[^/]+$/, "") + "identity-proofs.json";
    let proofs = [];
    if (existsSync(proofsFile)) {
      proofs = JSON.parse(readFileSync(proofsFile, "utf8"));
    }

    manifest = {
      agent: "local-verification",
      identity: {
        protocol: "agent-identity-v1",
        algorithm: "Ed25519",
        publicKey: keys.publicKey,
        handles: proofs.map(p => ({ platform: p.platform, handle: p.handle })),
        proofs,
        revoked: [],
      },
    };
  }

  const identity = manifest?.identity;
  if (!identity?.publicKey) {
    console.error("No public key found in identity block");
    console.log(JSON.stringify({ verified: false, error: "missing_public_key" }, null, 2));
    process.exit(1);
  }

  if (!identity?.proofs?.length) {
    console.log(JSON.stringify({
      verified: true,
      note: "No proofs to verify (empty proofs array)",
      agent: manifest?.agent || null,
      publicKey: identity.publicKey,
      algorithm: identity.algorithm || "Ed25519",
      proofs: [],
      handles: identity.handles || [],
      revoked: identity.revoked || [],
    }, null, 2));
    return { verified: true, proofs: [] };
  }

  // Verify proofs
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
    source: manifestFile ? `file:${manifestFile}` : "in-memory",
  };

  console.log(JSON.stringify(output, null, 2));
  if (!allValid) {
    const failed = results.filter(r => !r.valid);
    console.error(`\nFailed proofs: ${failed.map(f => f.platform).join(", ")}`);
  } else {
    console.log(`\nAll ${results.length} proofs verified successfully (standalone mode).`);
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

// --- Nostr ---

function bech32Encode(prefix, data) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  // Convert 8-bit bytes to 5-bit groups
  const values = [];
  let acc = 0, bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; values.push((acc >> bits) & 31); }
  }
  if (bits > 0) values.push((acc << (5 - bits)) & 31);
  // bech32 checksum (BIP-173)
  function polymod(v) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const val of v) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ val;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }
  function hrpExpand(hrp) {
    const r = [];
    for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
    r.push(0);
    for (const c of hrp) r.push(c.charCodeAt(0) & 31);
    return r;
  }
  const expanded = [...hrpExpand(prefix), ...values];
  const mod = polymod([...expanded, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return prefix + "1" + [...values, ...checksum].map(v => CHARSET[v]).join("");
}

function nostrKeygen(outputFile) {
  const privKey = crypto.randomBytes(32);
  const pubKey = schnorr.getPublicKey(privKey); // x-only (32 bytes)
  const privHex = Buffer.from(privKey).toString("hex");
  const pubHex = Buffer.from(pubKey).toString("hex");
  const npub = bech32Encode("npub", pubKey);
  const nsec = bech32Encode("nsec", privKey);

  const result = {
    algorithm: "secp256k1-schnorr",
    publicKey: pubHex,
    privateKey: privHex,
    npub,
    nsec,
    created: new Date().toISOString().split("T")[0],
    note: "Nostr keypair. npub is your public identity. nsec is secret — never share it.",
  };

  const file = outputFile || "nostr-keys.json";
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  console.log(`Nostr keypair generated: ${file}`);
  console.log(`npub: ${npub}`);
  console.log(`Public key (hex): ${pubHex}`);
  return result;
}

async function nostrSign(keysFile, content) {
  const keys = JSON.parse(readFileSync(keysFile, "utf8"));
  if (!keys.privateKey || keys.algorithm !== "secp256k1-schnorr") {
    console.error("Not a Nostr key file (expected algorithm: secp256k1-schnorr)");
    process.exit(1);
  }

  // NIP-01 event structure (kind 1 = text note)
  const created_at = Math.floor(Date.now() / 1000);
  const event = {
    pubkey: keys.publicKey,
    created_at,
    kind: 1,
    tags: [],
    content,
  };

  // Event ID = sha256 of serialized event
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  const id = crypto.createHash("sha256").update(serialized).digest("hex");
  event.id = id;

  // Schnorr sign the event ID
  const privBytes = Uint8Array.from(Buffer.from(keys.privateKey, "hex"));
  const sig = schnorr.sign(Uint8Array.from(Buffer.from(id, "hex")), privBytes);
  event.sig = Buffer.from(sig).toString("hex");

  console.log(JSON.stringify(event, null, 2));
  return event;
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

  case "verify-local":
    if (!args[1]) {
      console.error("Usage: identity-tool.mjs verify-local <keys-file> [manifest-file]");
      console.error("  keys-file: identity-keys.json (public key + optional identity-proofs.json in same dir)");
      console.error("  manifest-file: optional agent.json-style manifest to verify");
      process.exit(1);
    }
    verifyLocal(args[1], args[2]);
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

  case "nostr-keygen":
    nostrKeygen(args[1]);
    break;

  case "nostr-sign":
    if (!args[1] || !args[2]) {
      console.error("Usage: identity-tool.mjs nostr-sign <nostr-keys-file> <content>");
      process.exit(1);
    }
    nostrSign(args[1], args.slice(2).join(" "));
    break;

  default:
    console.log(`identity-tool.mjs — Cross-platform agent identity verification

Commands:
  keygen [output-file]                    Generate Ed25519 keypair
  sign <keys> <platform> <handle>         Sign a platform identity claim
  verify <manifest-url>                   Verify an agent's identity proofs (HTTP fetch)
  verify-local <keys> [manifest]          Verify proofs without HTTP fetch (standalone mode)
  manifest <keys> [proof-files...]        Generate agent.json identity block
  proof <keys> [--platform P]             Human-readable proof text
  nostr-keygen [output-file]              Generate Nostr secp256k1 keypair (npub/nsec)
  nostr-sign <keys> <content>             Sign a NIP-01 text note event

Protocol: agent-identity-v1 (Ed25519 signatures over JSON claims)
Nostr: NIP-01 events with schnorr signatures (secp256k1)
Spec: https://github.com/terminalcraft/moltbook-mcp`);
}
