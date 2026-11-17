import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAi4BharatRequest, decodeAi4BharatAudio } from '../agent/speech-providers.js';

test('maps supported voice modes to AI4Bharat language identifiers', () => {
  assert.equal(buildAi4BharatRequest('Hello', 'English').config.language.sourceLanguage, 'en');
  assert.equal(buildAi4BharatRequest('Namaste', 'Hinglish').config.language.sourceLanguage, 'en+hi');
  assert.equal(buildAi4BharatRequest('வணக்கம்', 'Tamil').config.language.sourceLanguage, 'ta');
  assert.throws(() => buildAi4BharatRequest('Hi', 'Tanglish'), /does not have a configured voice/);
});

test('decodes bounded provider audio and rejects malformed payloads', () => {
  assert.deepEqual([...decodeAi4BharatAudio({ audio: [{ audioContent: Buffer.from('RIFF').toString('base64') }] })], [82, 73, 70, 70]);
  assert.throws(() => decodeAi4BharatAudio({ audio: [{ audioContent: '**' }] }), /invalid or oversized/);
});
