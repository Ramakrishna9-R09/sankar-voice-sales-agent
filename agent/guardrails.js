const COMMERCIAL_CLAIM = /\b(?:price|pricing|costs?|fee|subscription|discount|off|free|refund|return|cancel(?:lation)?|guarantee(?:d)?|sla|uptime|response time|within \d+ (?:hours?|days?)|supports?|integrates? with|includes?|comes with|offers?|provides?|built[- ]in|feature(?:s)?)\b|(?:₹|\$|€|£)\s?\d|\b\d+(?:\.\d+)?\s?(?:%|percent|rupees?|inr|usd|eur)\b/i;
const SAFE_FALLBACK = 'I can’t verify that from the approved product information, so I don’t want to guess. I can arrange a follow-up with the team.';

function normalizedWords(text) {
  return String(text).toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}₹$€£.%]+/gu) || [];
}

export function validateSpokenSentence(sentence, { knowledge = [], toolActions = [] } = {}) {
  if (!COMMERCIAL_CLAIM.test(sentence)) return { ok: true, text: sentence };
  const evidence = [...knowledge.map((item) => item.text || ''), ...toolActions.map((item) => JSON.stringify(item))].join(' ');
  const evidenceWords = new Set(normalizedWords(evidence));
  const claimWords = normalizedWords(sentence).filter((word) => word.length > 2);
  const overlap = claimWords.filter((word) => evidenceWords.has(word)).length / Math.max(1, claimWords.length);
  const numericTokens = (sentence.match(/\b\d[\d,.]*\b/g) || []).map((value) => Number(value.replace(/,/g, '')));
  const moneyClaims = sentence.match(/(?:₹|\$|€|£|\bINR\b|\bUSD\b|\bEUR\b)\s?\d[\d,.]*/gi) || [];
  const currencyName = (raw) => ({ '₹': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP' })[raw] || raw?.toUpperCase();
  const amountFrom = (raw) => Number(raw?.match(/\d[\d,.]*/)?.[0]?.replace(/,/g, ''));
  const percentClaim = /\b\d+(?:\.\d+)?\s?(?:%|percent)\b/i.test(sentence);
  const percentEvidence = !percentClaim || numericTokens.every((amount) => evidence.includes(`${amount}%`) || evidence.toLowerCase().includes(`${amount} percent`));
  const numericEvidence = numericTokens.every((amount) => evidenceWords.has(String(amount))) && percentEvidence;
  const priceClaim = /\b(price|pricing|cost|costs|fee|subscription)\b/i.test(sentence);
  const verifiedPriceAmounts = toolActions.flatMap((action) => [action.total, action.unit_price].filter((value) => value != null).map(Number));
  // JSON tool output also contains quantities, which must never validate an unverified price.
  const priceNumbersVerified = !priceClaim || !numericTokens.length || numericTokens.every((amount) => verifiedPriceAmounts.includes(amount));
  const verifiedMoneyByTool = moneyClaims.length > 0 && moneyClaims.every((claim) => {
    const amount = amountFrom(claim);
    const currency = currencyName(claim.match(/₹|\$|€|£|\bINR\b|\bUSD\b|\bEUR\b/i)?.[0]);
    return toolActions.some((action) => {
      // Quantity is not monetary evidence: a one-seat order must never authorize a $1 claim.
      const verifiedAmounts = [action.total, action.unit_price].filter((value) => value != null).map(Number);
      return verifiedAmounts.includes(amount) && (!currency || String(action.currency || '').toUpperCase() === currency);
    });
  });
  if (percentEvidence && priceNumbersVerified && (numericEvidence || verifiedMoneyByTool) && (overlap >= 0.8 || (priceClaim && verifiedMoneyByTool))) return { ok: true, text: sentence };
  return { ok: false, text: SAFE_FALLBACK, reason: 'unsupported_commercial_claim' };
}

export { SAFE_FALLBACK };
