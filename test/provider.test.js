import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProviderConfig, chatPayloadOptions, providerAuthorization } from '../agent/provider.js';

test('selects open-model runtime without exposing credentials to the browser contract', () => {
  const config = aiProviderConfig({ AI_PROVIDER: 'local', LLM_BASE_URL: 'http://localhost:8000/v1', LLM_API_KEY: 'local-secret', LLM_MODEL: 'Qwen/Qwen3-8B-AWQ' });
  assert.equal(config.provider, 'local');
  assert.equal(config.configured, true);
  assert.deepEqual(chatPayloadOptions(config), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(providerAuthorization(config), { Authorization: 'Bearer local-secret' });
});

test('keeps Groq as a deliberate optional provider', () => {
  const config = aiProviderConfig({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-only', GROQ_CHAT_MODEL: 'test-model' });
  assert.equal(config.provider, 'groq');
  assert.equal(config.model, 'test-model');
  assert.equal(chatPayloadOptions(config).chat_template_kwargs, undefined);
});
