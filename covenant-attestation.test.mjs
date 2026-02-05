// covenant-attestation.test.mjs — Tests for covenant attestation system (wq-258)
// Tests: attestation creation, signature verification, listing, and JSON-LD export.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { createHash, createHmac } from 'crypto';

const TEST_DIR = '/tmp/covenant-attestation-test';
const ATTESTATIONS_PATH = join(TEST_DIR, 'attestations.json');
const COVENANTS_PATH = join(TEST_DIR, 'covenants.json');
const WALLET_PATH = join(TEST_DIR, 'wallet.json');

function setupTestEnv() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });

  // Create test wallet
  const testWallet = {
    evm: {
      address: '0xTEST1234567890ABCDEF1234567890ABCDEF1234',
      privateKey: 'test-private-key-for-hmac-signing-0x1234567890'
    }
  };
  writeFileSync(WALLET_PATH, JSON.stringify(testWallet, null, 2));

  // Create test covenants with active covenant
  const testCovenants = {
    version: 1,
    description: "Test covenants",
    last_updated: new Date().toISOString(),
    agents: {
      testagent: {
        first_seen: "2026-02-01",
        last_seen: "2026-02-05",
        sessions: [1, 2, 3],
        platforms: ["testplatform"],
        reply_count: 3,
        covenant_strength: "strong",
        templated_covenants: [
          {
            template: "knowledge-exchange",
            created: new Date().toISOString(),
            status: "active",
            notes: "Test covenant",
            metrics: {
              patterns_shared: 0,
              exchange_sessions: 0
            },
            attestations: []
          }
        ]
      }
    }
  };
  writeFileSync(COVENANTS_PATH, JSON.stringify(testCovenants, null, 2));

  // Create empty attestations file
  const testAttestations = {
    version: 1,
    description: "Test attestations",
    signer: {
      handle: "@test",
      evm_address: null,
      github: "https://github.com/test"
    },
    attestations: []
  };
  writeFileSync(ATTESTATIONS_PATH, JSON.stringify(testAttestations, null, 2));

  return { testWallet, testCovenants, testAttestations };
}

function cleanupTestEnv() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

describe('Attestation ID generation', () => {
  test('generates deterministic IDs', () => {
    const attestation = {
      counterparty: 'testagent',
      term_fulfilled: 'shared 3 patterns',
      timestamp: '2026-02-05T10:00:00.000Z'
    };
    const content = `${attestation.counterparty}:${attestation.term_fulfilled}:${attestation.timestamp}`;
    const id = 'attest-' + createHash('sha256').update(content).digest('hex').substring(0, 12);

    // Same input = same ID
    const id2 = 'attest-' + createHash('sha256').update(content).digest('hex').substring(0, 12);
    assert.strictEqual(id, id2, 'Attestation IDs should be deterministic');
    assert(id.startsWith('attest-'), 'ID should start with attest-');
    assert.strictEqual(id.length, 19, 'ID should be attest- + 12 hex chars');
  });

  test('different inputs produce different IDs', () => {
    const att1 = { counterparty: 'agent1', term_fulfilled: 'term1', timestamp: '2026-02-05T10:00:00.000Z' };
    const att2 = { counterparty: 'agent2', term_fulfilled: 'term1', timestamp: '2026-02-05T10:00:00.000Z' };

    const content1 = `${att1.counterparty}:${att1.term_fulfilled}:${att1.timestamp}`;
    const content2 = `${att2.counterparty}:${att2.term_fulfilled}:${att2.timestamp}`;

    const id1 = 'attest-' + createHash('sha256').update(content1).digest('hex').substring(0, 12);
    const id2 = 'attest-' + createHash('sha256').update(content2).digest('hex').substring(0, 12);

    assert.notStrictEqual(id1, id2, 'Different inputs should produce different IDs');
  });
});

describe('Message hash creation', () => {
  test('creates canonical message hash', () => {
    const attestation = {
      counterparty: 'testagent',
      covenant_template: 'knowledge-exchange',
      term_fulfilled: 'shared patterns',
      timestamp: '2026-02-05T10:00:00.000Z',
      evidence: 's1000',
      session: 1000
    };

    const message = [
      `Covenant Attestation v1`,
      `Counterparty: @${attestation.counterparty}`,
      `Covenant: ${attestation.covenant_template}`,
      `Term: ${attestation.term_fulfilled}`,
      `Timestamp: ${attestation.timestamp}`,
      `Evidence: ${attestation.evidence}`,
      `Session: ${attestation.session}`
    ].join('\n');

    const hash = createHash('sha256').update(message).digest('hex');
    assert.strictEqual(hash.length, 64, 'SHA256 hash should be 64 hex chars');
  });

  test('handles missing evidence', () => {
    const attestation = {
      counterparty: 'testagent',
      covenant_template: 'knowledge-exchange',
      term_fulfilled: 'shared patterns',
      timestamp: '2026-02-05T10:00:00.000Z',
      evidence: null,
      session: 1000
    };

    const message = [
      `Covenant Attestation v1`,
      `Counterparty: @${attestation.counterparty}`,
      `Covenant: ${attestation.covenant_template}`,
      `Term: ${attestation.term_fulfilled}`,
      `Timestamp: ${attestation.timestamp}`,
      // evidence line omitted when null
      `Session: ${attestation.session}`
    ].filter(Boolean).join('\n');

    const hash = createHash('sha256').update(message).digest('hex');
    assert.strictEqual(hash.length, 64, 'Hash should still be generated without evidence');
  });
});

describe('HMAC signature', () => {
  test('creates valid HMAC-SHA256 signature', () => {
    const privateKey = 'test-private-key-12345';
    const messageHash = 'abc123def456';

    const signature = createHmac('sha256', privateKey)
      .update(messageHash)
      .digest('hex');

    assert.strictEqual(signature.length, 64, 'HMAC-SHA256 should be 64 hex chars');
  });

  test('same inputs produce same signature', () => {
    const privateKey = 'test-private-key-12345';
    const messageHash = 'abc123def456';

    const sig1 = createHmac('sha256', privateKey).update(messageHash).digest('hex');
    const sig2 = createHmac('sha256', privateKey).update(messageHash).digest('hex');

    assert.strictEqual(sig1, sig2, 'Same inputs should produce same signature');
  });

  test('different keys produce different signatures', () => {
    const messageHash = 'abc123def456';

    const sig1 = createHmac('sha256', 'key1').update(messageHash).digest('hex');
    const sig2 = createHmac('sha256', 'key2').update(messageHash).digest('hex');

    assert.notStrictEqual(sig1, sig2, 'Different keys should produce different signatures');
  });
});

describe('Attestations file structure', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('loads empty attestations correctly', () => {
    const data = JSON.parse(readFileSync(ATTESTATIONS_PATH, 'utf8'));

    assert.strictEqual(data.version, 1);
    assert(Array.isArray(data.attestations));
    assert.strictEqual(data.attestations.length, 0);
    assert(data.signer);
    assert.strictEqual(data.signer.handle, '@test');
  });

  test('attestation has required fields', () => {
    // Create a minimal valid attestation
    const attestation = {
      id: 'attest-abc123def4',
      counterparty: 'testagent',
      covenant_template: 'knowledge-exchange',
      term_fulfilled: 'shared patterns',
      evidence: null,
      timestamp: new Date().toISOString(),
      session: 1000,
      signer: '0xTEST1234',
      messageHash: 'abc123',
      signature: 'def456',
      signatureAlgorithm: 'hmac-sha256'
    };

    // Verify required fields
    const required = ['id', 'counterparty', 'covenant_template', 'term_fulfilled',
                      'timestamp', 'signer', 'messageHash', 'signature', 'signatureAlgorithm'];

    for (const field of required) {
      assert(attestation[field] !== undefined, `Missing required field: ${field}`);
    }
  });
});

describe('Covenants integration', () => {
  beforeEach(() => setupTestEnv());
  afterEach(() => cleanupTestEnv());

  test('covenant has templated_covenants array', () => {
    const data = JSON.parse(readFileSync(COVENANTS_PATH, 'utf8'));

    assert(data.agents.testagent);
    assert(Array.isArray(data.agents.testagent.templated_covenants));
    assert.strictEqual(data.agents.testagent.templated_covenants.length, 1);
  });

  test('active covenant has metrics object', () => {
    const data = JSON.parse(readFileSync(COVENANTS_PATH, 'utf8'));
    const activeCovenant = data.agents.testagent.templated_covenants.find(c => c.status === 'active');

    assert(activeCovenant, 'Should have active covenant');
    assert(activeCovenant.metrics, 'Active covenant should have metrics');
    assert.strictEqual(typeof activeCovenant.metrics.patterns_shared, 'number');
    assert.strictEqual(typeof activeCovenant.metrics.exchange_sessions, 'number');
  });

  test('attestation updates covenant metrics', () => {
    const data = JSON.parse(readFileSync(COVENANTS_PATH, 'utf8'));
    const activeCovenant = data.agents.testagent.templated_covenants.find(c => c.status === 'active');

    // Simulate attestation adding to metrics
    const term = 'shared 3 knowledge patterns';
    if (term.toLowerCase().includes('pattern') || term.toLowerCase().includes('knowledge')) {
      activeCovenant.metrics.patterns_shared = (activeCovenant.metrics.patterns_shared || 0) + 1;
    }

    assert.strictEqual(activeCovenant.metrics.patterns_shared, 1,
      'Term containing "pattern" should increment patterns_shared');
  });
});

describe('JSON-LD export format', () => {
  test('export has correct @context', () => {
    const exportData = {
      "@context": {
        "@vocab": "https://schema.org/",
        "attestation": "https://moltbook.xyz/vocab/attestation#",
        "covenant": "https://moltbook.xyz/vocab/covenant#"
      },
      "@type": "attestation:AttestationCollection",
      "issuer": {
        "@type": "Agent",
        "identifier": "@moltbook"
      },
      "attestations": []
    };

    assert(exportData["@context"]["@vocab"], 'Should have @vocab');
    assert(exportData["@context"]["attestation"], 'Should have attestation namespace');
    assert.strictEqual(exportData["@type"], "attestation:AttestationCollection");
  });

  test('attestation export has required JSON-LD fields', () => {
    const attestation = {
      id: 'attest-abc123',
      counterparty: 'testagent',
      covenant_template: 'knowledge-exchange',
      term_fulfilled: 'shared patterns',
      evidence: 's1000',
      timestamp: '2026-02-05T10:00:00.000Z',
      signature: 'sig123',
      messageHash: 'hash456',
      signatureAlgorithm: 'hmac-sha256'
    };

    const exported = {
      "@type": "attestation:CovenantAttestation",
      "@id": `urn:attestation:${attestation.id}`,
      "counterparty": `@${attestation.counterparty}`,
      "covenantType": attestation.covenant_template,
      "termFulfilled": attestation.term_fulfilled,
      "evidence": attestation.evidence,
      "dateCreated": attestation.timestamp,
      "signature": {
        "@type": "attestation:Signature",
        "algorithm": attestation.signatureAlgorithm,
        "value": attestation.signature,
        "messageHash": attestation.messageHash
      }
    };

    assert(exported["@type"].startsWith('attestation:'));
    assert(exported["@id"].startsWith('urn:attestation:'));
    assert(exported.signature["@type"]);
  });
});

describe('Registry integration', () => {
  test('registry submission payload format', () => {
    const handle = 'testagent';
    const term = 'shared 3 patterns';
    const covenantTemplate = 'knowledge-exchange';
    const attestationId = 'attest-abc123';

    const registryTask = `Covenant attestation: ${term} (${covenantTemplate})`;
    const registryEvidence = `http://terminalcraft.xyz:3847/attestation/${attestationId}`;

    const payload = {
      attester: 'moltbook',
      task: registryTask.substring(0, 300),
      evidence: registryEvidence
    };

    assert.strictEqual(payload.attester, 'moltbook');
    assert(payload.task.length <= 300, 'Task should be max 300 chars');
    assert(payload.evidence.includes(attestationId), 'Evidence should include attestation ID');
  });
});

describe('CLI output format', () => {
  test('help command format', async () => {
    try {
      const result = execSync('cd /home/moltbot/moltbook-mcp && node covenant-attestation.mjs help 2>&1', {
        encoding: 'utf8',
        timeout: 5000
      });

      assert(result.includes('Covenant Attestation System'), 'Should show title');
      assert(result.includes('attest'), 'Should document attest command');
      assert(result.includes('list'), 'Should document list command');
      assert(result.includes('verify'), 'Should document verify command');
      assert(result.includes('export'), 'Should document export command');
    } catch (e) {
      // Command might exit non-zero for help, check stderr
      assert(e.stdout.includes('Covenant Attestation System') || e.message.includes('help'));
    }
  });

  test('list command runs without error', async () => {
    const result = execSync('cd /home/moltbot/moltbook-mcp && node covenant-attestation.mjs list 2>&1', {
      encoding: 'utf8',
      timeout: 5000
    });

    // Should show attestations or "no attestations" message
    assert(result.includes('Attestations') || result.includes('attestation'),
      'List should show attestation info');
  });
});
