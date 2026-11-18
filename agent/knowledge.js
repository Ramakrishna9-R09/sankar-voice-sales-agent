const STOP_WORDS = new Set('a an and are as at be by can could do for from has have how i in is it its me of on or our please the this to was we what when where with you your'.split(' '));
const MAX_CHUNKS = 5;
const MAX_INDEX_CHUNKS = 400;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 350;
let cachedIndex;
let cachedEmbeddingIndex;
let embeddingBuildPromise;
let embeddingRetryAfter = 0;

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
    if (target.length >= MAX_INDEX_CHUNKS) return;
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
    if (chunks.length >= MAX_INDEX_CHUNKS) break;
    if (!doc || typeof doc !== 'object' || !asText(doc.product) || !asText(doc.content || doc.answer || doc.text)) continue;
    pushChunks(chunks, asText(doc.product), asText(doc.kind || 'reference'), doc);
  }
  return chunks;
}

function defaultIndex() {
  return cachedIndex ||= buildKnowledgeIndex();
}

function lexicalScores(query, product, index) {
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
  });
}

function toResult(doc) {
  return { product: doc.product, kind: doc.kind, text: doc.text, source: doc.source, score: Number(doc.score.toFixed(3)) };
}

export function retrieveKnowledge(query, product = '', options = {}) {
  const maxResults = Math.max(1, Math.min(MAX_CHUNKS, Number(options.limit) || MAX_CHUNKS));
  const index = options.index || ((options.catalog || options.documents) ? buildKnowledgeIndex(options) : defaultIndex());
  return lexicalScores(query, product, index).filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, maxResults).map(toResult);
}

function validVector(value) {
  return Array.isArray(value) && value.length >= 32 && value.length <= 4096 && value.every((number) => Number.isFinite(number));
}

async function embedTexts(texts, { endpoint = process.env.EMBEDDINGS_URL, timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!endpoint) return null;
  const base = String(endpoint).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('EMBEDDINGS_URL must be an HTTP(S) URL.');
  const timeout = AbortSignal.timeout(Math.max(100, Math.min(30_000, Number(timeoutMs) || DEFAULT_EMBEDDING_TIMEOUT_MS)));
  const response = await fetchImpl(`${base}/embed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }), signal: timeout
  });
  if (!response.ok) throw new Error(`Embedding service returned ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length || !data.embeddings.every(validVector)) throw new Error('Embedding service returned an invalid vector response.');
  const dimension = data.embeddings[0]?.length;
  if (!dimension || data.embeddings.some((vector) => vector.length !== dimension)) throw new Error('Embedding vectors have inconsistent dimensions.');
  return data.embeddings;
}

export async function prepareKnowledgeEmbeddings({ index = defaultIndex(), endpoint = process.env.EMBEDDINGS_URL, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  if (!endpoint || !index.length) return false;
  if (cachedEmbeddingIndex?.index === index) return true;
  if (embeddingBuildPromise) return embeddingBuildPromise;
  if (Date.now() < embeddingRetryAfter) return false;
  embeddingBuildPromise = (async () => {
    try {
      const inputs = index.map((item) => `passage: ${item.product} · ${item.kind}\n${item.text}`);
      const vectors = await embedTexts(inputs, { endpoint, timeoutMs, fetchImpl });
      cachedEmbeddingIndex = { index, vectors };
      embeddingRetryAfter = 0;
      return true;
    } catch {
      // Retrieval remains available via the exact same trusted lexical index.
      // Retry later so starting the control plane before the worker is harmless.
      embeddingRetryAfter = Date.now() + 15_000;
      return false;
    } finally { embeddingBuildPromise = null; }
  })();
  return embeddingBuildPromise;
}

export function cosineSimilarity(left, right) {
  if (!validVector(left) || !validVector(right) || left.length !== right.length) return -1;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

export async function retrieveKnowledgeHybrid(query, product = '', options = {}) {
  const index = options.index || ((options.catalog || options.documents) ? buildKnowledgeIndex(options) : defaultIndex());
  const lexical = lexicalScores(query, product, index);
  const maxResults = Math.max(1, Math.min(MAX_CHUNKS, Number(options.limit) || MAX_CHUNKS));
  const lexicalFallback = () => ({ items: lexical.filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, maxResults).map(toResult), mode: 'lexical' });
  if (!String(query || '').trim()) return lexicalFallback();
  let vectors = options.documentEmbeddings;
  if (!vectors && !options.index && cachedEmbeddingIndex?.index === index) vectors = cachedEmbeddingIndex.vectors;
  if (!vectors && !options.index && process.env.EMBEDDINGS_URL) {
    // First-turn retrieval must not wait for a cold CPU model download/index. The
    // worker is warmed asynchronously; later turns use dense retrieval if ready.
    void prepareKnowledgeEmbeddings({ index });
    return lexicalFallback();
  }
  if (!vectors || vectors.length !== index.length) return lexicalFallback();
  let queryVector = options.queryEmbedding;
  if (!queryVector && process.env.EMBEDDINGS_URL) {
    const configuredTimeout = Number(process.env.EMBEDDING_REQUEST_TIMEOUT_MS);
    const timeoutMs = options.timeoutMs || (Number.isFinite(configuredTimeout) && configuredTimeout >= 100 && configuredTimeout <= 30_000 ? configuredTimeout : DEFAULT_EMBEDDING_TIMEOUT_MS);
    try { [queryVector] = await embedTexts([`query: ${String(query).slice(0, 900)}`], { timeoutMs, fetchImpl: options.fetchImpl || fetch }); }
    catch { return lexicalFallback(); }
  }
  if (!validVector(queryVector)) return lexicalFallback();

  const lexicalMax = Math.max(1, ...lexical.map((doc) => doc.score));
  const minSimilarity = Number.isFinite(options.minSimilarity) ? options.minSimilarity : 0.30;
  const ranked = index.map((item, position) => {
    const denseScore = cosineSimilarity(queryVector, vectors[position]);
    const lexicalScore = Math.max(0, lexical[position]?.score || 0) / lexicalMax;
    return { ...item, denseScore, score: denseScore * 0.78 + lexicalScore * 0.22 };
  }).filter((doc) => (!product || doc.product.toLowerCase() === String(product).trim().toLowerCase()) && doc.denseScore >= minSimilarity)
    .sort((a, b) => b.score - a.score).slice(0, maxResults);
  return { items: ranked.map(toResult), mode: 'embedding' };
}

export function knowledgePromptBlock(chunks = []) {
  if (!chunks.length) return 'No approved product documentation matched the prospect’s question. Do not infer product facts; say you cannot verify that and offer a human follow-up.';
  return chunks.map((chunk, index) => `[${index + 1}] product=${chunk.product}; kind=${chunk.kind}; source=${chunk.source}\n${chunk.text}`).join('\n\n').slice(0, 3600);
}
