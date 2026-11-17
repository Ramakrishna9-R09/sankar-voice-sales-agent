import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeIndex, knowledgePromptBlock, retrieveKnowledge } from '../agent/knowledge.js';

test('retrieves the most relevant trusted catalog chunks for the requested product', () => {
  const index = buildKnowledgeIndex({
    catalog: {
      'Nexus CRM': { description: 'Tracks sales opportunities for small teams.', features: ['WhatsApp lead inbox', 'Follow-up reminders'] },
      'Ledger Desk': { description: 'Accounting workflow for finance teams.', features: ['Tax reporting'] }
    },
    documents: [{ product: 'Nexus CRM', kind: 'policy', source: 'policy-1', content: 'Data is retained for 30 days.' }]
  });
  const hits = retrieveKnowledge('Does it have WhatsApp lead inbox and reminders?', 'Nexus CRM', { index });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].product, 'Nexus CRM');
  assert.match(knowledgePromptBlock(hits), /WhatsApp lead inbox/);
  assert.ok(hits.every((item) => item.product === 'Nexus CRM'));
});

test('does not retrieve or synthesize an answer when trusted documents do not match', () => {
  const results = retrieveKnowledge('Does the product provide guaranteed 99.99% uptime?', 'Nexus CRM', { index: [] });
  assert.deepEqual(results, []);
  assert.match(knowledgePromptBlock(results), /Do not infer product facts/);
});
