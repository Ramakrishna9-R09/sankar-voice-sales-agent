const LANGUAGE_ALIASES = new Map([
  ['english', 'English'], ['indian english', 'English'], ['en in', 'English'],
  ['hindi', 'Hindi'], ['hinglish', 'Hinglish'],
  ['tamil', 'Tamil'], ['tanglish', 'Tanglish'], ['telugu', 'Telugu']
]);

export function normalizeSpeechLanguage(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  return LANGUAGE_ALIASES.get(key) || 'English';
}

export function resolveSttRoute(language, env = process.env) {
  const normalized = normalizeSpeechLanguage(language);
  if (normalized === 'Tamil' || normalized === 'Tanglish') return env.STT_WS_URL_TAMIL || env.STT_WS_URL || '';
  if (normalized === 'Telugu') return env.STT_WS_URL_TELUGU || env.STT_WS_URL_TAMIL || env.STT_WS_URL || '';
  return env.STT_WS_URL_HINDI || env.STT_WS_URL || '';
}

export function languageStyleGuidance(value) {
  const language = normalizeSpeechLanguage(value);
  const guidance = {
    English: 'Use clear, natural Indian English. Prefer familiar Indian business phrasing, preserve product names, and avoid forced US idioms.',
    Hindi: 'Use conversational Hindi that is easy to understand in a phone conversation. Preserve product names and common technical terms when that is clearer.',
    Hinglish: 'Use natural Hindi-English code-switching as a bilingual Indian speaker would. Keep product names and familiar business terms in English; follow the prospect’s language mix.',
    Tamil: 'Use conversational Tamil for spoken replies. Preserve product names and technical terms when translation would be unclear.',
    Tanglish: 'Use natural Tamil-English code-switching and familiar business terms. Follow the prospect’s mix instead of forcing a fixed ratio.',
    Telugu: 'Use conversational Telugu for spoken replies. Preserve product names and technical terms when translation would be unclear.'
  };
  return guidance[language];
}
