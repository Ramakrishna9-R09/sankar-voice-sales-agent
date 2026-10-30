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
  // Keep stage transitions deterministic; the model advises within a stage but cannot skip discovery arbitrarily.
  const validCurrent = AGENT_STAGES.includes(current) ? current : 'introduction';
  const userTurns = messages.filter((message) => message.role === 'user' && !message.internal).length;
  if (toolNames.includes('end_call')) return 'summary_generation';
  if (intent === 'objection') return 'objection_handling';
  if (intent === 'buying_signal' || toolNames.includes('schedule_followup') || toolNames.includes('generate_quote')) return 'closing';
  if (userTurns === 0) return 'introduction';
  if (validCurrent === 'objection_handling') return userTurns >= 4 ? 'closing' : 'discovery';
  if (userTurns < 3) return 'discovery';
  if (userTurns < 5) return 'pitch';
  return 'closing';
}

export function normalizeIntent(value) {
  return VALID_INTENTS.has(value) ? value : 'neutral';
}

