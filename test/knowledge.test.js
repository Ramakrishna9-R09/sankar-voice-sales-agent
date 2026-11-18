import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeIndex, knowledgePromptBlock, prepareKnowledgeEmbeddings, retrieveKnowledge, retrieveKnowledgeHybrid } from '../agent/knowledge.js';

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

test('hybrid retrieval combines dense similarity with lexical evidence and keeps product scoping', async () => {
  const index = buildKnowledgeIndex({ catalog: {
    'Nexus CRM': { features: ['WhatsApp lead inbox for sales teams'] },
    'Ledger Desk': { features: ['Tax reporting for finance teams'] }
  } });
  const vector = (first) => [first, ...Array(31).fill(0)];
  const result = await retrieveKnowledgeHybrid('WhatsApp leads', 'Nexus CRM', {
    index,
    documentEmbeddings: index.map((_item, position) => vector(position === 0 ? 1 : -1)),
    queryEmbedding: vector(1),
    minSimilarity: 0.3
  });
  assert.equal(result.mode, 'embedding');
  assert.equal(result.items[0].product, 'Nexus CRM');
  assert.match(result.items[0].text, /WhatsApp lead inbox/);
});

test('hybrid retrieval falls back to lexical ranking for invalid vectors or empty queries', async () => {
  const index = buildKnowledgeIndex({ catalog: { 'Nexus CRM': { features: ['WhatsApp lead inbox'] } } });
  const vectors = [Array(32).fill(0)];
  const invalid = await retrieveKnowledgeHybrid('WhatsApp lead inbox', 'Nexus CRM', {
    index, documentEmbeddings: vectors, queryEmbedding: [1, 2]
  });
  assert.equal(invalid.mode, 'lexical');
  assert.equal(invalid.items[0].product, 'Nexus CRM');

  const empty = await retrieveKnowledgeHybrid('', '', {
    index, documentEmbeddings: vectors, queryEmbedding: Array(32).fill(1)
  });
  assert.equal(empty.mode, 'lexical');
  assert.deepEqual(empty.items, []);
});

test('embedding preparation batches trusted passages and validates the worker response', async () => {
  const index = buildKnowledgeIndex({ catalog: { 'Unique E5 Fixture': { description: 'Approved multilingual information.' } } });
  let request;
  const ready = await prepareKnowledgeEmbeddings({
    index,
    endpoint: 'http://embedding-worker',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ embeddings: [Array(32).fill(0.25)] }) };
    }
  });
  assert.equal(ready, true);
  assert.equal(request.url, 'http://embedding-worker/embed');
  assert.match(request.body.texts[0], /^passage: Unique E5 Fixture/);
});
