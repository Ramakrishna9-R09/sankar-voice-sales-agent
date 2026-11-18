import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, nextStage } from '../agent/stages.js';
import { normalizeEvaluation, talkListenRatio } from '../agent/evaluation.js';

test('stage transitions follow discovery, objections, buying signals, and close actions', () => {
  assert.equal(nextStage('introduction', [{ role: 'user', content: 'Hello' }], 'neutral'), 'discovery');
  assert.equal(nextStage('discovery', [{ role: 'user', content: 'Our team loses time on manual billing workflows.' }], 'objection'), 'objection_handling');
  assert.equal(classifyIntent('We are ready to subscribe'), 'buying_signal');
  assert.equal(nextStage('pitch', [{ role: 'user', content: 'Can you send a quote?' }], 'buying_signal'), 'closing');
  assert.equal(nextStage('closing', [{ role: 'user', content: 'No' }], 'neutral', ['end_call']), 'summary_generation');
});

test('evaluation clamps judge scores and includes operator speech in talk share', () => {
  const messages = [{ role: 'user', content: 'I need fewer missed calls.' }, { role: 'operator', content: 'I can arrange that callback.' }];
  const result = normalizeEvaluation({ evaluation: { factuality_and_compliance: 14 } }, messages);
  assert.equal(result.evaluation.factuality_and_compliance, 10);
  assert.deepEqual(talkListenRatio(messages), { prospect_percent: 50, assistant_percent: 50, prospect_words: 5, assistant_words: 5 });
});

test('evaluation audit flags unsupported commercial claims and missing qualification evidence', () => {
  const messages = [
    { role: 'user', content: 'We want a CRM tool for our sales team.' },
    { role: 'assistant', content: 'It includes guaranteed 99.99% uptime.' }
  ];
  const result = normalizeEvaluation({
    risk_flags: Array.from({ length: 8 }, (_item, index) => `Model flag ${index + 1}`),
    evaluation: { suggested_improvements: [] }
  }, messages, []);
  assert.match(result.risk_flags[0], /unsupported commercial claim/i);
  assert.ok(result.risk_flags.some((flag) => /Lead qualification is incomplete/i.test(flag)));
  assert.match(result.evaluation.suggested_improvements[0], /buying timeline/);
});

test('evaluation audit accepts a claim that is supported by the surfaced retrieval source', () => {
  const messages = [
    { role: 'user', content: 'We need a CRM to save reporting time. Our sales manager will decide next month.' },
    { role: 'assistant', content: 'Nexus CRM includes WhatsApp lead inbox for sales teams.' }
  ];
  const actions = [{
    name: 'check_product_info', product: 'Nexus CRM',
    sources: [{ kind: 'feature', text: 'Nexus CRM includes WhatsApp lead inbox for sales teams.' }]
  }];
  const result = normalizeEvaluation({}, messages, actions);
  assert.deepEqual(result.risk_flags, []);
});
