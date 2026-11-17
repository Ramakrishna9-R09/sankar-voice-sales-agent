const PROVIDERS = Object.freeze({ groq: 'https://api.groq.com/openai/v1' });

export function aiProviderConfig(env = process.env) {
  const requested = String(env.AI_PROVIDER || 'groq').toLowerCase();
  const provider = requested === 'local' ? 'local' : 'groq';
  const baseUrl = (provider === 'local' ? env.LLM_BASE_URL : env.GROQ_BASE_URL) || PROVIDERS.groq;
  const apiKey = (provider === 'local' ? env.LLM_API_KEY : env.GROQ_API_KEY) || '';
  const model = (provider === 'local' ? env.LLM_MODEL : env.GROQ_CHAT_MODEL) || (provider === 'local' ? 'Qwen/Qwen3-8B-AWQ' : 'openai/gpt-oss-120b');
  return { provider, baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model, configured: Boolean(baseUrl && (provider === 'local' || apiKey.trim())) };
}

export function chatPayloadOptions(config = aiProviderConfig()) {
  // Qwen3's vLLM chat template enables reasoning by default; disable it at rendering time for live voice turns.
  return config.provider === 'local' && /qwen3/i.test(config.model) ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

export function providerAuthorization(config = aiProviderConfig()) {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}
