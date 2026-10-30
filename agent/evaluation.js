import { leadStatuses } from './tools.js';

export const evaluationInstruction = `Analyze the completed SaaS sales call as a fair sales coach. Return exactly one JSON object with these keys: summary (string), customer_needs (string), objections (string), next_steps (string), status (string), buying_signals (array of concise strings), risk_flags (array of concise strings), prospect_memory (object with company string, preferences array of strings, objections array of strings), evaluation (object with discovery_quality integer 0-10, objection_handling_quality integer 0-10, need_alignment integer 0-10, factuality_and_compliance integer 0-10, empathy_and_tone integer 0-10, next_step_clarity integer 0-10, overall_sales_effectiveness integer 0-10, strengths array, suggested_improvements array). Scores must be evidence-based; assess claims against verified tool actions and flag unsupported commitments. Do not reward a pitch that ignores discovery. Use only these status values: ${leadStatuses.join(', ')}. Use No Response if the prospect never replied. Do not invent facts. No markdown.`;

export function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

export function talkListenRatio(messages = []) {
  const prospectWords = messages.filter((message) => message.role === 'user' && !message.internal).reduce((sum, message) => sum + words(message.content), 0);
  const assistantWords = messages.filter((message) => message.role === 'assistant' || message.role === 'operator').reduce((sum, message) => sum + words(message.content), 0);
  const total = prospectWords + assistantWords;
  return { prospect_percent: total ? Math.round(prospectWords / total * 100) : 0, assistant_percent: total ? Math.round(assistantWords / total * 100) : 0, prospect_words: prospectWords, assistant_words: assistantWords };
}

export function normalizeEvaluation(data = {}, messages = []) {
  const statusValues = new Set(leadStatuses);
  const validScore = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(10, Math.round(Number(value)))) : 0;
  const prospectReplied = messages.some((message) => message.role === 'user' && !message.internal);
  const evaluation = data.evaluation || {};
  const customerNeeds = String(data.customer_needs || 'Not clearly established.').slice(0, 600);
  const objections = String(data.objections || 'No clear objection raised.').slice(0, 600);
  const status = statusValues.has(data.status) ? data.status : (prospectReplied ? 'Interested' : 'No Response');
  return {
    summary: String(data.summary || 'Call ended; review transcript for details.').slice(0, 900),
    customer_needs: customerNeeds,
    objections,
    next_steps: String(data.next_steps || 'Review the transcript and follow up as appropriate.').slice(0, 600),
    status,
    buying_signals: Array.isArray(data.buying_signals) ? data.buying_signals.map((item) => String(item).slice(0, 180)).slice(0, 8) : [],
    risk_flags: Array.isArray(data.risk_flags) ? data.risk_flags.map((item) => String(item).slice(0, 180)).slice(0, 8) : [],
    prospect_memory: {
      company: String(data.prospect_memory?.company || '').slice(0, 120),
      preferences: Array.isArray(data.prospect_memory?.preferences) ? data.prospect_memory.preferences.map((item) => String(item).slice(0, 180)).slice(0, 8) : [],
      objections: Array.isArray(data.prospect_memory?.objections) ? data.prospect_memory.objections.map((item) => String(item).slice(0, 180)).slice(0, 8) : []
    },
    evaluation: {
      discovery_quality: validScore(evaluation.discovery_quality),
      objection_handling_quality: validScore(evaluation.objection_handling_quality),
      need_alignment: validScore(evaluation.need_alignment),
      factuality_and_compliance: validScore(evaluation.factuality_and_compliance),
      empathy_and_tone: validScore(evaluation.empathy_and_tone),
      next_step_clarity: validScore(evaluation.next_step_clarity),
      overall_sales_effectiveness: validScore(evaluation.overall_sales_effectiveness),
      talk_to_listen_ratio: talkListenRatio(messages),
      strengths: Array.isArray(evaluation.strengths) ? evaluation.strengths.map((item) => String(item).slice(0, 200)).slice(0, 6) : [],
      suggested_improvements: Array.isArray(evaluation.suggested_improvements) ? evaluation.suggested_improvements.map((item) => String(item).slice(0, 200)).slice(0, 6) : []
    }
  };
}

