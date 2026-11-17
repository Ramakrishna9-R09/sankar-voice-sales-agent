const STOP_WORDS = new Set('a an and are as at be by can could do for from has have how i in is it its me of on or our please the this to was we what when where with you your'.split(' '));
const MAX_CHUNKS = 5;
let cachedIndex;

function parseEnvJson(name, fallback) {
  try { return JSON.parse(process.env[name] || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function terms(text = '') {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}₹$€£.%]+/gu, ' ').split(/\s+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  return '';
}

function pushChunks(target, product, label, value) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const text = typeof entry === 'object' && entry ? asText(entry.content || entry.answer || entry.text || entry.value) : asText(entry);
    if (!text) continue;
    const question = typeof entry === 'object' && entry ? asText(entry.question) : '';
    const source = typeof entry === 'object' && entry ? asText(entry.source || entry.id) : '';
    target.push({ product, kind: label, text: `${question ? `Q: ${question}\n` : ''}${text}`.slice(0, 900), source: source || `${product}:${label}` });
  }
}

export function buildKnowledgeIndex({ catalog = parseEnvJson('PRODUCT_CATALOG_JSON', parseEnvJson('GROQ_PRODUCT_CATALOG', {})), documents = parseEnvJson('SALES_KNOWLEDGE_JSON', []) } = {}) {
  const chunks = [];
  for (const [name, product] of Object.entries(catalog || {})) {
    if (!product || typeof product !== 'object') continue;
    pushChunks(chunks, name, 'description', product.description);
    pushChunks(chunks, name, 'feature', product.features);
    pushChunks(chunks, name, 'integration', product.integrations);
    pushChunks(chunks, name, 'faq', product.faqs || product.faq);
    pushChunks(chunks, name, 'policy', product.policies || product.policy);
    pushChunks(chunks, name, 'service-level', product.service_levels || product.slas);
  }
  const external = Array.isArray(documents) ? documents : [];
  for (const doc of external.slice(0, 500)) {
    if (!doc || typeof doc !== 'object' || !asText(doc.product) || !asText(doc.content || doc.answer || doc.text)) continue;
    pushChunks(chunks, asText(doc.product), asText(doc.kind || 'reference'), doc);
  }
  return chunks;
}

export function retrieveKnowledge(query, product = '', options = {}) {
  const maxResults = Math.max(1, Math.min(MAX_CHUNKS, Number(options.limit) || MAX_CHUNKS));
  const index = options.index || ((options.catalog || options.documents) ? buildKnowledgeIndex(options) : (cachedIndex ||= buildKnowledgeIndex()));
  const queryTerms = [...new Set(terms(query))];
  if (!queryTerms.length) return [];
  const docs = index.map((item) => ({ ...item, words: terms(`${item.product} ${item.kind} ${item.text}`) }));
  const docFreq = new Map(queryTerms.map((term) => [term, docs.filter((doc) => doc.words.includes(term)).length]));
  return docs.map((doc) => {
    if (product && doc.product.toLowerCase() !== String(product).trim().toLowerCase()) return { ...doc, score: 0 };
    const wordSet = new Set(doc.words);
    const matched = queryTerms.filter((term) => wordSet.has(term));
    const weighted = matched.reduce((sum, term) => sum + Math.log(1 + (docs.length + 1) / (1 + (docFreq.get(term) || 0))), 0);
    const coverage = matched.length / Math.max(1, queryTerms.length);
    const exact = String(doc.text).toLowerCase().includes(String(query).toLowerCase()) ? 1 : 0;
    return { ...doc, score: weighted * (0.35 + coverage) + exact * 2 + (doc.product.toLowerCase() === String(product).toLowerCase() ? 0.2 : 0) };
  }).filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, maxResults)
    .map(({ product: productName, kind, text, source, score }) => ({ product: productName, kind, text, source, score: Number(score.toFixed(3)) }));
}

export function knowledgePromptBlock(chunks = []) {
  if (!chunks.length) return 'No approved product documentation matched the prospect’s question. Do not infer product facts; say you cannot verify that and offer a human follow-up.';
  return chunks.map((chunk, index) => `[${index + 1}] product=${chunk.product}; kind=${chunk.kind}; source=${chunk.source}\n${chunk.text}`).join('\n\n').slice(0, 3600);
}
