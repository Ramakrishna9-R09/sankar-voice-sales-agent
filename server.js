import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const apiBase = 'https://api.groq.com/openai/v1';
const limits = new Map();

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/', (req, res, next) => {
  const now = Date.now();
  const key = `${req.ip}:${req.path}`;
  const entry = limits.get(key) || { start: now, count: 0 };
  if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
  entry.count += 1;
  limits.set(key, entry);
  if (entry.count > 35) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  next();
});

const configured = () => Boolean(process.env.GROQ_API_KEY?.trim());
app.get('/api/health', (_req, res) => res.json({ configured: configured(), provider: 'Groq', chatModel: process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b', voice: 'Groq Orpheus · English' }));

async function groq(pathname, payload, accept = 'application/json') {
  if (!configured()) {
    const err = new Error('AI is not configured. Add GROQ_API_KEY to .env and restart the server.');
    err.status = 503;
    throw err;
  }
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35_000)
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`AI provider returned ${response.status}: ${text.slice(0, 260)}`);
    err.status = response.status >= 500 ? 502 : response.status;
    throw err;
  }
  return response;
}

app.post('/api/turn', async (req, res) => {
  try {
    const { prospect, product, goal, language, messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length > 24) return res.status(400).json({ error: 'A call can include up to 24 conversation turns.' });
    const context = `You are the voice sales assistant for Sankar Group. Product: ${String(product || 'the SaaS product').slice(0, 120)}. Prospect: ${String(prospect || 'a new prospect').slice(0, 100)}. Call goal: ${String(goal || 'understand needs and determine a suitable next step').slice(0, 240)}. Speak in ${String(language || 'English').slice(0, 40)}. Be warm, precise, curious, and respectful. Ask one short question at a time. Listen before pitching, answer the question asked, acknowledge objections without arguing, and never invent prices, product capabilities, security claims, or customer results. If uncertain, say so and offer a follow-up. If the prospect declines, thank them and end politely. Keep each spoken turn to 1–3 concise sentences, with no markdown or lists.`;
    const history = messages.slice(-18).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 1500) }));
    const payload = { model: process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b', messages: [{ role: 'system', content: context }, ...history], temperature: 0.55, max_completion_tokens: 170 };
    const response = await groq('/chat/completions', payload);
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'The AI returned an empty response. Please try again.' });
    res.json({ reply, model: data.model || payload.model });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.name === 'TimeoutError' ? 'The AI response took too long. Please try again.' : err.message || 'The AI service is temporarily unavailable.' });
  }
});

app.post('/api/summarize', async (req, res) => {
  try {
    const { product, prospect, messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length > 60) return res.status(400).json({ error: 'Invalid transcript.' });
    const transcript = messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Prospect'}: ${String(m.content || '').slice(0, 1500)}`).join('\n').slice(0, 16000);
    const response = await groq('/chat/completions', {
      model: process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b', temperature: 0.1, max_completion_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Analyze this SaaS sales conversation. Return one JSON object with exactly these string keys: summary, customer_needs, objections, next_steps, status. Keep each value concise and factual. status must be exactly one of Converted, Interested, Follow-up Required, Not Interested, Demo Requested, No Response. Use No Response if the prospect never replied. Classify only from evidence in the transcript. No markdown.' },
        { role: 'user', content: `Product: ${String(product || 'SaaS product').slice(0, 120)}\nProspect: ${String(prospect || 'New prospect').slice(0, 100)}\nTranscript:\n${transcript || '(No transcript)'}` }
      ]
    });
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const statuses = ['Converted', 'Interested', 'Follow-up Required', 'Not Interested', 'Demo Requested', 'No Response'];
    if (!statuses.includes(parsed.status)) parsed.status = messages.some((m) => m.role === 'user') ? 'Interested' : 'No Response';
    res.json({ ...parsed, model: data.model || process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b' });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Could not analyze this call.' });
  }
});

app.post('/api/speech', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 900);
    if (!text) return res.status(400).json({ error: 'Speech text is required.' });
    const response = await groq('/audio/speech', {
      model: process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english',
      voice: process.env.GROQ_TTS_VOICE || 'austin', input: text, response_format: 'wav'
    }, 'audio/wav');
    res.set('Content-Type', response.headers.get('content-type') || 'audio/wav');
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Voice generation failed.' });
  }
});

app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: '1h' }));
app.get('*path', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Vercel consumes the Express app as a serverless function. Local development
// still uses the same app through the standard Node HTTP listener.
if (!process.env.VERCEL) app.listen(port, () => console.log(`Sankar Voice running at http://localhost:${port}`));

export default app;
