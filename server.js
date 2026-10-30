import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentMessages } from './agent/prompt.js';
import { classifyIntent, nextStage, normalizeIntent } from './agent/stages.js';
import { agentTools, executeTool } from './agent/tools.js';
import { evaluationInstruction, normalizeEvaluation } from './agent/evaluation.js';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || 3000);
const apiBase = 'https://api.groq.com/openai/v1';
const limits = new Map();
const MODEL = () => process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
const stages = ['introduction', 'discovery', 'pitch', 'objection_handling', 'closing', 'summary_generation'];

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
  if (limits.size > 5000) for (const [candidate, value] of limits) if (now - value.start > 60_000) limits.delete(candidate);
  if (entry.count > 35) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  next();
});

const configured = () => Boolean(process.env.GROQ_API_KEY?.trim());
app.get('/api/health', (_req, res) => res.json({ configured: configured(), provider: 'Groq', chatModel: MODEL(), voice: 'Groq Orpheus · English', stages }));

async function groq(pathname, payload, { accept = 'application/json', signal } = {}) {
  if (!configured()) {
    const err = new Error('AI is not configured. Add GROQ_API_KEY to .env and restart the server.');
    err.status = 503;
    throw err;
  }
  const timeout = AbortSignal.timeout(40_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify(payload), signal: combinedSignal
  });
  if (!response.ok) {
    const text = await response.text();
    let details = text.slice(0, 320);
    try { details = JSON.parse(text).error?.message || details; } catch { /* retain bounded provider message */ }
    const err = new Error(`AI provider returned ${response.status}: ${details}`);
    err.status = response.status >= 500 ? 502 : response.status;
    throw err;
  }
  return response;
}

function splitSentences(buffer, flush = false) {
  const sentences = [];
  let rest = buffer;
  const boundary = /[.!?](?:["')\]]+)?\s+/;
  while (true) {
    const match = boundary.exec(rest);
    if (!match) break;
    const end = match.index + match[0].length;
    const sentence = rest.slice(0, end).trim();
    if (sentence) sentences.push(sentence);
    rest = rest.slice(end).trimStart();
  }
  if (flush && rest.trim()) { sentences.push(rest.trim()); rest = ''; }
  return { sentences, rest };
}

function splitLongSpeech(sentence, max = 180) {
  const chunks = [];
  let rest = sentence;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.55) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function consumeGroqStream(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const textParts = [];
  const toolMap = new Map();
  let finishReason = null;
  async function processFrame(frame) {
    const line = frame.split('\n').find((part) => part.startsWith('data:'));
    if (!line) return;
    const value = line.slice(5).trim();
    if (value === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(value); } catch { return; }
    const delta = chunk.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      textParts.push(delta.content);
      await onText(delta.content);
    }
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? 0;
      const existing = toolMap.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) existing.id += call.id;
      if (call.function?.name) existing.function.name += call.function.name;
      if (call.function?.arguments) existing.function.arguments += call.function.arguments;
      toolMap.set(index, existing);
    }
    if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
  }
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) await processFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) await processFrame(buffer);
  return { text: textParts.join(''), toolCalls: [...toolMap.values()], finishReason };
}

async function runAgentTurn(body, onEvent, signal) {
  if (Array.isArray(body.messages) && body.messages.length > 80) { const err = new Error('This call has reached its 80-turn context limit. End the call to save its summary and start a fresh session.'); err.status = 400; throw err; }
  const messages = Array.isArray(body.messages) ? body.messages.filter((message) => message && typeof message === 'object' && ['assistant', 'user'].includes(message.role)).slice(-80) : [];
  const userMessage = [...messages].reverse().find((message) => message.role === 'user' && !message.internal)?.content || '';
  const intent = normalizeIntent(classifyIntent(userMessage));
  let stage = stages.includes(body.stage) ? body.stage : 'introduction';
  stage = nextStage(stage, messages, intent);
  await onEvent({ type: 'stage', stage });
  await onEvent({ type: 'intent', intent });
  let chatMessages = buildAgentMessages({ ...body, messages, stage });
  let sentenceBuffer = '';
  let fullText = '';
  let shouldEnd = false;
  let leadStatus = null;
  const toolActions = [];
  const publishText = async (chunk) => {
    if (!chunk) return;
    fullText += chunk;
    await onEvent({ type: 'delta', text: chunk });
    sentenceBuffer += chunk;
    const split = splitSentences(sentenceBuffer);
    sentenceBuffer = split.rest;
    for (const sentence of split.sentences) for (const part of splitLongSpeech(sentence)) await onEvent({ type: 'sentence', text: part });
  };

  for (let round = 0; round < 4; round += 1) {
    const payload = { model: MODEL(), messages: chatMessages, temperature: 0.35, max_completion_tokens: 220, stream: true, tools: agentTools, tool_choice: 'auto', parallel_tool_calls: false };
    const response = await groq('/chat/completions', payload, { accept: 'text/event-stream', signal });
    const completion = await consumeGroqStream(response, publishText);
    if (!completion.toolCalls.length) break;
    const toolCalls = completion.toolCalls.map((call, index) => ({ ...call, index }));
    chatMessages.push({ role: 'assistant', content: completion.text || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      if (!call.function.name || call.function.arguments.length > 4000) {
        chatMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'Invalid tool arguments.' }) });
        continue;
      }
      let args;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
      const result = await executeTool(call.function.name, args);
      if (call.function.name === 'end_call' && result.end_call) shouldEnd = true;
      if (call.function.name === 'update_lead_status' && result.updated) leadStatus = result.status;
      let action = null;
      if (call.function.name === 'schedule_followup') action = { name: call.function.name, requested_time: result.requested_time, channel: result.channel, booked: false };
      else if (['calculate_pricing', 'generate_quote'].includes(call.function.name)) action = { name: call.function.name, available: result.available, product: result.product, quantity: result.quantity, total: result.total, currency: result.currency, billing_period: result.billing_period };
      else if (call.function.name === 'update_lead_status' && result.updated) action = { name: call.function.name, status: result.status, reason: result.reason };
      else if (call.function.name === 'end_call' && result.end_call) action = { name: call.function.name, reason: result.reason };
      if (action) toolActions.push(action);
      await onEvent({ type: 'tool', name: call.function.name, ok: !result.error, action });
      chatMessages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 3000) });
    }
  }
  const trailing = splitSentences(sentenceBuffer, true);
  for (const sentence of trailing.sentences) for (const part of splitLongSpeech(sentence)) await onEvent({ type: 'sentence', text: part });
  if (!fullText.trim()) {
    fullText = 'I’m sorry, I lost my train of thought. Could you please say that once more?';
    await onEvent({ type: 'delta', text: fullText });
    await onEvent({ type: 'sentence', text: fullText });
  }
  const finalStage = shouldEnd ? 'summary_generation' : stage;
  await onEvent({ type: 'stage', stage: finalStage });
  if (leadStatus) await onEvent({ type: 'lead_status', status: leadStatus });
  if (shouldEnd) await onEvent({ type: 'action', action: 'end_call' });
  return { reply: fullText.trim(), stage: finalStage, intent, leadStatus, shouldEnd, toolActions };
}

app.post('/api/turn/stream', async (req, res) => {
  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const send = (event) => { if (!res.writableEnded && !controller.signal.aborted) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  try {
    await runAgentTurn(req.body || {}, send, controller.signal);
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!controller.signal.aborted) {
      send({ type: 'error', error: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The AI took too long to respond. Please try again.' : error.message || 'The AI service is temporarily unavailable.' });
      res.end();
    }
  }
});

app.post('/api/turn', async (req, res) => {
  try {
    const events = [];
    const result = await runAgentTurn(req.body || {}, async (event) => events.push(event));
    res.json({ ...result, events });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.name === 'TimeoutError' ? 'The AI response took too long. Please try again.' : error.message || 'The AI service is temporarily unavailable.' });
  }
});

app.post('/api/summarize', async (req, res) => {
  try {
    const { product, prospect, messages = [], actions = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length > 80) return res.status(400).json({ error: 'Invalid transcript.' });
    const transcript = messages.map((message) => `${message.role === 'assistant' ? 'Assistant' : 'Prospect'}: ${String(message.content || '').slice(0, 1600)}`).join('\n').slice(0, 22000);
    const response = await groq('/chat/completions', {
      model: MODEL(), temperature: 0.1, max_completion_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${evaluationInstruction} Also include an evidence-based company name in prospect_memory.company only if stated in the transcript.` },
        { role: 'user', content: `Product: ${String(product || 'SaaS product').slice(0, 120)}\nProspect: ${String(prospect || 'New prospect').slice(0, 100)}\nVerified tool actions (calendar requests are not bookings):\n${JSON.stringify(Array.isArray(actions) ? actions.slice(0, 20) : []).slice(0, 3000)}\nTranscript:\n${transcript || '(No transcript)'}` }
      ]
    });
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    res.json({ ...normalizeEvaluation(parsed, messages), tool_actions: Array.isArray(actions) ? actions.slice(0, 20) : [], model: data.model || MODEL() });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.name === 'TimeoutError' ? 'Call evaluation timed out. Please retry from call history.' : error.message || 'Could not analyze this call.' });
  }
});

app.post('/api/speech', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 200);
    if (!text) return res.status(400).json({ error: 'Speech text is required.' });
    const response = await groq('/audio/speech', {
      model: process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english',
      voice: process.env.GROQ_TTS_VOICE || 'austin', input: text, response_format: 'wav'
    }, { accept: 'audio/wav' });
    res.set('Content-Type', response.headers.get('content-type') || 'audio/wav');
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'Voice generation failed.' });
  }
});

app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: '1h' }));
app.get('*path', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

if (!process.env.VERCEL) app.listen(port, () => console.log(`Sankar Voice running at http://localhost:${port}`));

export default app;
