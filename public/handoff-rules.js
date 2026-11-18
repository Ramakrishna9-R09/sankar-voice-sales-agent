const HUMAN_REQUEST = /\b(?:speak|talk|connect|transfer|put me through|let me talk to|let me speak to)\b.{0,45}\b(?:human|person|someone|representative|manager|supervisor|support agent|real agent)\b|\b(?:human|person|representative|manager|supervisor|real agent)\b.{0,35}\b(?:please|now|instead)\b|\b(?:someone|a person)\s+(?:from|in)\s+(?:support|sales)\b|मुझे.{0,24}(?:इंसान|व्यक्ति|प्रतिनिधि)|मानव.{0,20}बात|மனிதரிடம்.{0,20}பேச|ஒரு நபரிடம்.{0,20}பேச|మనిషితో.{0,20}మాట్లాడ|ప్రతినిధితో.{0,20}మాట్లాడ/u;
const FRUSTRATION = /\b(frustrated|angry|upset|not listening|wasting my time|already told you|stop repeating|useless|annoying|ridiculous|this is going nowhere|you keep asking)\b|நேரத்தை வீணாக்க|கேட்கவில்லை|சொன்னேனே|समय बर्बाद|सुन नहीं रहे|बार बार पूछ|చెప్పాను కదా|వినడం లేదు/u;
const BILLING = /\b(invoice|billing|bill|charged|charge|payment|refund|gst|tax|subscription|renewal|cancel(?:lation)?|credit note|prorat(?:e|ed|ion))\b|பில்|கட்டணம்|ரீஃபண்ட்|வரி|బిల్లు|చార్జ్|రిఫండ్|పన్ను|बिल|भुगतान|रिफंड|जीएसटी/u;
const COMPLEX_BILLING = /\b(wrong|incorrect|duplicate|double|twice|disput(?:e|ed)|chargeback|failed|revers(?:e|al)|penalty|contract|tax invoice|gst invoice|mismatch|not matching|charged me|charged us|refund status|prorat(?:e|ed|ion))\b|தவறாக|இரண்டு முறை|முரண்பாடு|தவறான|తప్పుగా|రెండుసార్లు|వివాదం|తప్పు|गलत|दो बार|विवाद|वापस नहीं/u;

function normalizedWords(value) {
  return String(value || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
}

function isRepeated(previous, current) {
  const left = new Set(normalizedWords(previous));
  const right = new Set(normalizedWords(current));
  if (left.size < 5 || right.size < 5) return false;
  const overlap = [...left].filter((word) => right.has(word)).length / Math.max(left.size, right.size);
  return overlap >= 0.88;
}

export function humanHandoffReason(text, state = {}) {
  const input = String(text || '').trim();
  if (HUMAN_REQUEST.test(input)) return 'The prospect explicitly requested a human representative.';
  if (BILLING.test(input) && COMPLEX_BILLING.test(input)) return 'The prospect raised a disputed or complex billing issue that needs a human review.';

  if (FRUSTRATION.test(input)) state.frustrationSignals = (Number(state.frustrationSignals) || 0) + 1;
  const normalized = normalizedWords(input).join(' ');
  if (normalized && (normalized === state.lastUserUtterance || isRepeated(state.lastUserUtterance, normalized))) state.repeatedUserTurns = (Number(state.repeatedUserTurns) || 0) + 1;
  else state.repeatedUserTurns = 0;
  state.lastUserUtterance = normalized;

  if (state.frustrationSignals) state.showFrustrationSignal = true;
  if (state.frustrationSignals >= 2) return 'Repeated frustration signals were detected.';
  if (state.repeatedUserTurns >= 2) return 'The prospect appears stuck in a repeated conversation loop.';
  return '';
}
