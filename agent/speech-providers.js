const AI4BHARAT_LANGUAGES = Object.freeze({ English: 'en', Hindi: 'hi', Hinglish: 'en+hi', Tamil: 'ta', Telugu: 'te' });

export function buildAi4BharatRequest(text, language, gender = 'female') {
  const languageCode = AI4BHARAT_LANGUAGES[String(language || '').trim()];
  if (!languageCode) throw new Error(`AI4Bharat Indic-TTS does not have a configured voice for ${String(language || 'this language')}.`);
  return {
    input: [{ source: String(text || '').trim().slice(0, 320) }],
    config: { language: { sourceLanguage: languageCode }, gender: gender === 'male' ? 'male' : 'female' }
  };
}

export function decodeAi4BharatAudio(payload) {
  const encoded = payload?.audio?.[0]?.audioContent;
  if (typeof encoded !== 'string' || encoded.length > 14_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('AI4Bharat TTS returned an invalid or oversized audio payload.');
  }
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length || audio.length > 10_000_000) throw new Error('AI4Bharat TTS audio exceeded the configured size limit.');
  return audio;
}
