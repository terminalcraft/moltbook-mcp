#!/usr/bin/env node
// game-attestation.mjs — Portable competitive credential protocol
// Signs game results with Ed25519 identity keys. Other agents can verify.
//
// Usage:
//   node game-attestation.mjs attest <keys-file> <game> <result-json>
//   node game-attestation.mjs verify <attestation-json-or-file>
//   node game-attestation.mjs badge <keys-file> <game> <achievement> <detail>
//
// Result JSON format:
//   {"opponent":"agentname","outcome":"win","score":"3-1","match_id":"xyz"}
//
// Attestation is self-signed — it proves the agent claims this result.
// For server-verified results, the game server should co-sign.

import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

function loadKeys(file) {
  if (!existsSync(file)) { console.error(`Keys not found: ${file}`); process.exit(1); }
  return JSON.parse(readFileSync(file, "utf8"));
}

function sign(keys, payload) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(keys.privateKeyPkcs8, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const message = JSON.stringify(payload);
  const signature = crypto.sign(null, Buffer.from(message), privKey).toString("hex");
  return { message, signature };
}

function verifySignature(publicKey, message, signature) {
  const pubKeyDer = Buffer.from(ED25519_SPKI_PREFIX + publicKey, "hex");
  const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message), pubKey, Buffer.from(signature, "hex"));
}

// --- Commands ---

function attest(keysFile, game, resultJson) {
  const keys = loadKeys(keysFile);
  let result;
  try { result = JSON.parse(resultJson); } catch { console.error("Invalid result JSON"); process.exit(1); }

  const payload = {
    type: "game-attestation",
    version: 1,
    game,
    agent: keys.publicKey,
    result,
    timestamp: new Date().toISOString(),
  };

  const { message, signature } = sign(keys, payload);
  const attestation = {
    ...payload,
    signature,
    message,
  };

  console.log(JSON.stringify(attestation, null, 2));
}

function verifyAttestation(input) {
  let attestation;
  if (existsSync(input)) {
    attestation = JSON.parse(readFileSync(input, "utf8"));
  } else {
    try { attestation = JSON.parse(input); } catch { console.error("Invalid JSON or file not found"); process.exit(1); }
  }

  if (!attestation.agent || !attestation.message || !attestation.signature) {
    console.error("Missing required fields: agent, message, signature");
    process.exit(1);
  }

  const valid = verifySignature(attestation.agent, attestation.message, attestation.signature);
  const parsed = JSON.parse(attestation.message);
  console.log(JSON.stringify({
    valid,
    game: parsed.game,
    result: parsed.result,
    agent: parsed.agent,
    timestamp: parsed.timestamp,
  }, null, 2));

  if (valid) {
    console.log("\nAttestation signature is valid.");
    console.log("Note: This proves the agent signed this claim. Server co-signing required for trustless verification.");
  } else {
    console.error("\nSignature verification FAILED.");
  }
}

function badge(keysFile, game, achievement, detail) {
  const keys = loadKeys(keysFile);
  const payload = {
    type: "game-badge",
    version: 1,
    game,
    agent: keys.publicKey,
    achievement,
    detail,
    timestamp: new Date().toISOString(),
  };

  const { message, signature } = sign(keys, payload);
  console.log(JSON.stringify({ ...payload, signature, message }, null, 2));
}

// --- CLI ---

const args = process.argv.slice(2);
switch (args[0]) {
  case "attest":
    if (args.length < 4) { console.error("Usage: game-attestation.mjs attest <keys-file> <game> <result-json>"); process.exit(1); }
    attest(args[1], args[2], args[3]);
    break;
  case "verify":
    if (!args[1]) { console.error("Usage: game-attestation.mjs verify <attestation-json-or-file>"); process.exit(1); }
    verifyAttestation(args[1]);
    break;
  case "badge":
    if (args.length < 5) { console.error("Usage: game-attestation.mjs badge <keys-file> <game> <achievement> <detail>"); process.exit(1); }
    badge(args[1], args[2], args[3], args[4]);
    break;
  default:
    console.log(`game-attestation.mjs — Portable competitive credential protocol

Commands:
  attest <keys> <game> <result-json>     Sign a game result
  verify <attestation-json-or-file>      Verify an attestation signature
  badge <keys> <game> <achievement> <detail>  Sign an achievement badge

Protocol: game-attestation-v1 (Ed25519 signed JSON claims)
Games: shellsword, colonysim, or any game name`);
}
