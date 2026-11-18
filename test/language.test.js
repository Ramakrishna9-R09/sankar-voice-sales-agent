import test from 'node:test';
import assert from 'node:assert/strict';
import { languageStyleGuidance, normalizeSpeechLanguage, resolveSttRoute } from '../agent/language.js';

test('normalizes Indian language labels and gives natural code-switch guidance', () => {
  assert.equal(normalizeSpeechLanguage('en-IN'), 'English');
  assert.equal(normalizeSpeechLanguage('Tanglish'), 'Tanglish');
  assert.match(languageStyleGuidance('Hinglish'), /code-switch/i);
  assert.match(languageStyleGuidance('Indian English'), /Indian English/i);
});

test('routes Hindi/Hinglish, Tamil/Tanglish, and Telugu to configured ASR workers', () => {
  const env = {
    STT_WS_URL_HINDI: 'wss://asr.example/hindi',
    STT_WS_URL_TAMIL: 'wss://asr.example/tamil',
    STT_WS_URL_TELUGU: 'wss://asr.example/telugu'
  };
  assert.equal(resolveSttRoute('Hindi', env), env.STT_WS_URL_HINDI);
  assert.equal(resolveSttRoute('Hinglish', env), env.STT_WS_URL_HINDI);
  assert.equal(resolveSttRoute('Tamil', env), env.STT_WS_URL_TAMIL);
  assert.equal(resolveSttRoute('Tanglish', env), env.STT_WS_URL_TAMIL);
  assert.equal(resolveSttRoute('Telugu', env), env.STT_WS_URL_TELUGU);
  assert.equal(resolveSttRoute('Telugu', { STT_WS_URL_TAMIL: env.STT_WS_URL_TAMIL }), env.STT_WS_URL_TAMIL);
});
