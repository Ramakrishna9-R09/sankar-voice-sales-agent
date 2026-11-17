import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAsrSamples, wordErrorRate } from '../agent/wer.js';

test('computes whitespace-token WER with Unicode normalization', () => {
  assert.deepEqual(wordErrorRate('Hello, world!', 'hello world'), { errors: 0, reference_words: 2, wer: 0 });
  assert.equal(wordErrorRate('நல்ல காலை வணக்கம்', 'நல்ல காலை').wer, 1 / 3);
});

test('reports WER per language to expose accent and code-switch regressions', () => {
  const report = evaluateAsrSamples([
    { language: 'Indian English', reference: 'Please send the invoice', hypothesis: 'Please send invoice' },
    { language: 'Hinglish', reference: 'kal demo schedule karna hai', hypothesis: 'kal demo schedule karna hai' }
  ]);
  assert.equal(report.utterances, 2);
  assert.equal(report.languages.Hinglish.wer, 0);
  assert.equal(report.languages['Indian English'].wer, 0.25);
  assert.throws(() => evaluateAsrSamples([]), /non-empty/);
});
