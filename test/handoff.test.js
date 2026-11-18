import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackHandoffBrief, normalizeHandoffBrief } from '../agent/handoff.js';
import { humanHandoffReason } from '../public/handoff-rules.js';

test('explicit human requests and complex billing disputes trigger an operator handoff', () => {
  assert.match(humanHandoffReason('Could I speak to a human representative?'), /explicitly requested/i);
  assert.match(humanHandoffReason('Our invoice charged us twice; please review the duplicate payment.'), /complex billing/i);
});

test('repeated frustration and repeated conversation loops escalate after repeated signals', () => {
  const frustration = {};
  assert.equal(humanHandoffReason('You keep asking me the same thing and this is wasting my time.', frustration), '');
  assert.match(humanHandoffReason('You keep asking me the same thing and this is wasting my time.', frustration), /frustration/i);

  const loop = {};
  const sameRequest = 'I need an update about my account options for next quarter.';
  assert.equal(humanHandoffReason(sameRequest, loop), '');
  assert.equal(humanHandoffReason(sameRequest, loop), '');
  assert.match(humanHandoffReason(sameRequest, loop), /repeated conversation loop/i);
});

test('handoff summary fallback uses the latest prospect statement and marks its source', () => {
  const fallback = buildFallbackHandoffBrief([
    { role: 'user', content: 'We are comparing CRM tools.' },
    { role: 'assistant', content: 'What is your timeline?' },
    { role: 'user', content: 'Please have a person call me tomorrow.' }
  ], 'The prospect explicitly requested a human representative.');
  assert.equal(fallback.summary_source, 'transcript_fallback');
  assert.match(fallback.summary, /call me tomorrow/);
  assert.match(fallback.next_step, /agree on the next step/);
});

test('malformed generated briefs fall back to the transcript-derived brief', () => {
  const fallback = buildFallbackHandoffBrief([], 'Billing review requested.');
  assert.equal(normalizeHandoffBrief({ summary: 'invented only' }, fallback), fallback);
  const normalized = normalizeHandoffBrief({ summary: 'Facts', needs: 'Need', objections: 'Concern', next_step: 'Review' }, fallback);
  assert.equal(normalized.summary_source, 'ai');
});
