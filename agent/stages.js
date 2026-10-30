export const AGENT_STAGES = Object.freeze([
  'introduction',
  'discovery',
  'pitch',
  'objection_handling',
  'closing',
  'summary_generation'
]);

const VALID_INTENTS = new Set(['buying_signal', 'objection', 'question', 'neutral']);

export function classifyIntent(text = '') {
  const value = String(text).toLowerCase();
  if (/\b(too expensive|costly|concern|worried|not sure|already use|competitor|can't|cannot|no budget|not now|not interested|doesn't work|won't buy|not buying|rather not)\b/.test(value)) return 'objection';
  if (/\b(buy|purchase|sign up|subscribe|ready to start|let's do it|go ahead|send (me )?(the )?(contract|quote)|move forward)\b/.test(value)) return 'buying_signal';
  if (/\?|\b(what|how|when|where|who|which|can you|could you|does it|is there|tell me)\b/.test(value)) return 'question';
  return 'neutral';
}

export function nextStage(current, messages, intent, toolNames = []) {
  // Deterministic transitions keep discovery evidence-driven while allowing a clear objection or buying signal to move the call immediately.
  const validCurrent = AGENT_STAGES.includes(current) ? current : 'introduction';
  const customerTurns = messages.filter((message) => message.role === 'user' && !message.internal);
  const userTurns = customerTurns.length;
  if (toolNames.includes('end_call')) return 'summary_generation';
  if (intent === 'objection') return 'objection_handling';
  if (intent === 'buying_signal' || toolNames.includes('schedule_followup') || toolNames.includes('generate_quote')) return 'closing';
  if (userTurns === 0) return 'introduction';
  if (validCurrent === 'introduction') return 'discovery';
  if (validCurrent === 'objection_handling') return 'pitch';
  if (validCurrent === 'closing') return 'closing';
  if (validCurrent === 'pitch') return userTurns >= 5 ? 'closing' : 'pitch';
  const discoveryEvidence = customerTurns.filter((message) => {
    const text = String(message.content || '').toLowerCase();
    const hasNeedContext = /\b(workflow|process|team|need|goal|challenge|problem|currently|today|time|cost|impact|priority|budget|using|use)\b/.test(text);
    return hasNeedContext && text.trim().split(/\s+/).length >= 5;
  }).length;
  return discoveryEvidence >= 2 || userTurns >= 4 ? 'pitch' : 'discovery';
}

export function normalizeIntent(value) {
  return VALID_INTENTS.has(value) ? value : 'neutral';
}

