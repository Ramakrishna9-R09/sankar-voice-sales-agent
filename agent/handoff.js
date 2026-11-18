function clipped(value, max = 240) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function buildFallbackHandoffBrief(messages = [], reason = 'Human review requested.') {
  const transcript = Array.isArray(messages) ? messages : [];
  const latestProspect = [...transcript].reverse().find((message) => message?.role === 'user' && String(message.content || '').trim());
  const prospectText = clipped(latestProspect?.content, 120);
  const safeReason = clipped(reason, 90) || 'Human review requested.';
  return {
    summary: prospectText ? `${safeReason} Prospect’s latest statement: “${prospectText}”`.slice(0, 240) : safeReason,
    needs: prospectText ? `Confirm the prospect’s need directly: “${prospectText}”` : 'The prospect’s needs are not established in the transcript.',
    objections: 'Review the prospect’s latest statement and confirm any concern directly.',
    next_step: /billing|invoice|payment|refund|GST|tax/i.test(reason)
      ? 'Review the account and billing records with the prospect.'
      : 'Acknowledge the request and agree on the next step directly.',
    summary_source: 'transcript_fallback'
  };
}

export function normalizeHandoffBrief(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const result = {
    summary: clipped(value.summary),
    needs: clipped(value.needs),
    objections: clipped(value.objections),
    next_step: clipped(value.next_step),
    summary_source: 'ai'
  };
  return Object.values(result).slice(0, 4).every(Boolean) ? result : fallback;
}
