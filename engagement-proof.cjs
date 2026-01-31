#!/usr/bin/env node
// engagement-proof.cjs — Reference implementation for agent engagement proof generation and verification
// Generates ed25519-signed engagement proof records per the ATProto agent engagement proof lexicon.
// Usage:
//   node engagement-proof.cjs generate --did <did> --action <post|reply|like> [--target <at-uri>] [--cid <record-cid>]
//   node engagement-proof.cjs verify <proof-json-file>
//   node engagement-proof.cjs keygen [--output <path>]
//   node engagement-proof.cjs demo

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_DIR = path.join(require('os').homedir(), '.config', 'moltbook');
const KEY_PATH = path.join(KEY_DIR, 'engagement-proof-keys.json');

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    createdAt: new Date().toISOString()
  };
}

function loadKeys() {
  if (!fs.existsSync(KEY_PATH)) return null;
  return JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
}

function saveKeys(keys) {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, JSON.stringify(keys, null, 2));
}

function sign(privateKeyB64url, message) {
  const privKeyDer = Buffer.from(privateKeyB64url, 'base64url');
  const privKey = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privKey);
  return sig.toString('base64url');
}

function verify(publicKeyB64url, message, signatureB64url) {
  const pubKeyDer = Buffer.from(publicKeyB64url, 'base64url');
  const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
  const sig = Buffer.from(signatureB64url, 'base64url');
  return crypto.verify(null, Buffer.from(message, 'utf8'), pubKey, sig);
}

function createEngagementProof({ agentDid, action, targetUri, recordCid, privateKey }) {
  const createdAt = new Date().toISOString();
  // The signed payload: deterministic concatenation of fields
  const payload = [agentDid, action, recordCid || '', createdAt].join('|');
  const platformSig = sign(privateKey, payload);

  const proof = {
    $type: 'app.bsky.agent.engagementProof',
    agentDid,
    action,
    ...(targetUri && { targetUri }),
    ...(recordCid && { recordCid }),
    platformSig,
    createdAt
  };
  return proof;
}

function verifyEngagementProof(proof, publicKey) {
  const payload = [proof.agentDid, proof.action, proof.recordCid || '', proof.createdAt].join('|');
  return verify(publicKey, payload, proof.platformSig);
}

function createTrustAttestation({ subjectDid, confidence, scope, basis, privateKey, attestorDid }) {
  const createdAt = new Date().toISOString();
  const payload = [attestorDid, subjectDid, confidence.toString(), scope || '', createdAt].join('|');
  const sig = sign(privateKey, payload);

  return {
    $type: 'app.bsky.agent.trustAttestation',
    subjectDid,
    confidence,
    ...(scope && { scope }),
    ...(basis && basis.length > 0 && { basis }),
    attestorSig: sig,
    attestorDid,
    createdAt
  };
}

// CLI
const args = process.argv.slice(2);
const cmd = args[0];

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

if (cmd === 'keygen') {
  const keys = generateKeypair();
  const out = getArg('--output') || KEY_PATH;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(keys, null, 2));
  console.log(`Ed25519 keypair generated: ${out}`);
  console.log(`Public key: ${keys.publicKey.slice(0, 20)}...`);

} else if (cmd === 'generate') {
  const keys = loadKeys();
  if (!keys) { console.error('No keys found. Run: node engagement-proof.cjs keygen'); process.exit(1); }
  const did = getArg('--did') || 'did:plc:terminalcraft';
  const action = getArg('--action') || 'post';
  const targetUri = getArg('--target');
  const recordCid = getArg('--cid');

  const proof = createEngagementProof({
    agentDid: did, action, targetUri, recordCid, privateKey: keys.privateKey
  });
  proof.publicKey = keys.publicKey;
  console.log(JSON.stringify(proof, null, 2));

} else if (cmd === 'verify') {
  const file = args[1];
  if (!file) { console.error('Usage: node engagement-proof.cjs verify <proof.json>'); process.exit(1); }
  const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pubKeyFile = getArg('--pubkey');
  let publicKey;
  if (pubKeyFile) {
    const k = JSON.parse(fs.readFileSync(pubKeyFile, 'utf8'));
    publicKey = k.publicKey;
  } else {
    const keys = loadKeys();
    if (!keys) { console.error('No keys found. Provide --pubkey <file> or run keygen.'); process.exit(1); }
    publicKey = keys.publicKey;
  }
  const valid = verifyEngagementProof(proof, publicKey);
  console.log(valid ? '✓ Proof signature valid' : '✗ Proof signature INVALID');
  process.exit(valid ? 0 : 1);

} else if (cmd === 'demo') {
  console.log('=== Engagement Proof Demo ===\n');

  // 1. Generate keypair
  const keys = generateKeypair();
  console.log('1. Generated ed25519 keypair');
  console.log(`   Public key: ${keys.publicKey.slice(0, 30)}...\n`);

  // 2. Create engagement proof
  const proof = createEngagementProof({
    agentDid: 'did:plc:terminalcraft',
    action: 'reply',
    targetUri: 'at://did:plc:penny/app.bsky.feed.post/abc123',
    recordCid: 'bafyreie5cvwrqz7xwmyqmcdlbz3udm2rmz6hg4',
    privateKey: keys.privateKey
  });
  console.log('2. Created engagement proof:');
  console.log(JSON.stringify(proof, null, 2));
  console.log();

  // 3. Verify it
  const valid = verifyEngagementProof(proof, keys.publicKey);
  console.log(`3. Verification: ${valid ? '✓ VALID' : '✗ INVALID'}`);
  console.log();

  // 4. Create trust attestation
  const attestation = createTrustAttestation({
    subjectDid: 'did:plc:penny',
    confidence: 0.82,
    scope: 'protocol-design',
    basis: [`at://did:plc:terminalcraft/app.bsky.agent.engagementProof/tid123`],
    privateKey: keys.privateKey,
    attestorDid: 'did:plc:terminalcraft'
  });
  console.log('4. Created trust attestation:');
  console.log(JSON.stringify(attestation, null, 2));
  console.log();

  // 5. Tamper detection
  const tampered = { ...proof, action: 'like' };
  const tamperedValid = verifyEngagementProof(tampered, keys.publicKey);
  console.log(`5. Tamper detection (changed action): ${tamperedValid ? '✗ MISSED tampering!' : '✓ Tampering detected'}`);

} else {
  console.log(`engagement-proof.cjs — Agent engagement proof reference implementation

Commands:
  keygen                  Generate ed25519 keypair
  generate                Create a signed engagement proof
    --did <did>           Agent DID (default: did:plc:terminalcraft)
    --action <action>     Action type: post, reply, like, repost, follow
    --target <at-uri>     Target record URI (for reply/like/repost)
    --cid <cid>           CID of the record being attested
  verify <proof.json>     Verify a proof's signature
    --pubkey <keys.json>  Public key file (default: local keypair)
  demo                    Run full demo (keygen → proof → verify → tamper detect)

See docs/agent-engagement-proof-lexicon.md for the full spec.`);
}

// Export for use as module
module.exports = { generateKeypair, createEngagementProof, verifyEngagementProof, createTrustAttestation, sign, verify };
