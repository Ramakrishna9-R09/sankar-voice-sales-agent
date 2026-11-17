function normalize(text) {
  return String(text || '').toLocaleLowerCase().normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

export function wordErrorRate(reference, hypothesis) {
  const expected = normalize(reference);
  const actual = normalize(hypothesis);
  if (!expected.length) throw new Error('WER requires a non-empty reference transcript.');
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let row = 1; row <= expected.length; row += 1) {
    const current = [row];
    for (let col = 1; col <= actual.length; col += 1) {
      current[col] = Math.min(
        current[col - 1] + 1,
        previous[col] + 1,
        previous[col - 1] + (expected[row - 1] === actual[col - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return { errors: previous[actual.length], reference_words: expected.length, wer: previous[actual.length] / expected.length };
}

export function evaluateAsrSamples(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('Provide a non-empty array of {language, reference, hypothesis} samples.');
  const groups = new Map();
  for (const sample of samples) {
    if (!sample?.language || typeof sample.reference !== 'string' || typeof sample.hypothesis !== 'string') throw new Error('Every ASR sample needs language, reference, and hypothesis fields.');
    const group = groups.get(sample.language) || { utterances: 0, errors: 0, reference_words: 0 };
    const result = wordErrorRate(sample.reference, sample.hypothesis);
    group.utterances += 1;
    group.errors += result.errors;
    group.reference_words += result.reference_words;
    groups.set(sample.language, group);
  }
  const languages = Object.fromEntries([...groups].map(([language, group]) => [language, {
    utterances: group.utterances,
    errors: group.errors,
    reference_words: group.reference_words,
    wer: Number((group.errors / group.reference_words).toFixed(4))
  }]));
  const totalErrors = Object.values(languages).reduce((sum, group) => sum + group.errors, 0);
  const totalWords = Object.values(languages).reduce((sum, group) => sum + group.reference_words, 0);
  return { utterances: samples.length, reference_words: totalWords, errors: totalErrors, wer: Number((totalErrors / totalWords).toFixed(4)), languages };
}
