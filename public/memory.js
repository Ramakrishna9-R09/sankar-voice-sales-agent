const DB_NAME = 'sankar.voice.memory.v2';
const LEGACY_DB = 'sankar.voice.prospects.v1';
const DAY = 86_400_000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('prospects')) database.createObjectStore('prospects', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('episodes')) {
        const episodes = database.createObjectStore('episodes', { keyPath: 'id' });
        episodes.createIndex('prospect_key', 'prospect_key', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const keyFor = (name) => String(name || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const clean = (value, limit = 240) => String(value || '').trim().slice(0, limit);
const uniqueFacts = (facts) => [...new Map(facts.map((fact) => [`${fact.type}:${fact.value.toLocaleLowerCase()}`, fact])).values()];
const decay = (fact, now) => Math.max(0, Number(fact.importance) || 0) * Math.exp(-Math.max(0, now - (Number(fact.last_seen_at) || now)) / (180 * DAY));
const confidenceOf = (item, fallback = 0.5) => Math.max(0, Math.min(1, Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : fallback));
const words = (text) => new Set(String(text || '').toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
function relevance(value, query) {
  const target = words(query); if (!target.size) return 0;
  const source = words(value); let matches = 0;
  for (const word of target) if (source.has(word)) matches += 1;
  return matches / Math.sqrt(target.size * Math.max(1, source.size));
}

export function rankSemanticFacts(facts = [], query = '', now = Date.now()) {
  return facts
    .map((fact) => ({ ...fact, confidence: confidenceOf(fact), effective_importance: Number(decay(fact, now).toFixed(3)), relevance: relevance(`${fact.type} ${fact.value}`, query) }))
    .filter((fact) => fact.effective_importance >= 0.06)
    // Confidence moderates a remembered claim; query relevance still leads when the current topic names it.
    .sort((a, b) => {
      const rank = (fact) => fact.relevance * 0.5 + fact.effective_importance * (0.3 + fact.confidence * 0.2);
      return rank(b) - rank(a);
    })
    .slice(0, 8);
}

function transaction(database, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const result = operation(tx.objectStore(storeName));
    tx.oncomplete = () => { database.close(); resolve(result?.result); };
    tx.onerror = () => { database.close(); reject(tx.error); };
  });
}

async function loadLegacyProfile(key) {
  // Migrate the prior one-record profile format lazily, without forcing an IndexedDB version bump on an open app tab.
  return new Promise((resolve) => {
    let request;
    try { request = indexedDB.open(LEGACY_DB, 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('prospects')) request.result.createObjectStore('prospects', { keyPath: 'key' }); };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('prospects')) { database.close(); resolve(null); return; }
      const read = database.transaction('prospects').objectStore('prospects').get(key);
      read.onsuccess = () => { const value = read.result || null; database.close(); resolve(value); };
      read.onerror = () => { database.close(); resolve(null); };
    };
  });
}

function legacyToFacts(old, now) {
  if (!old) return [];
  const facts = [{ type: 'name', value: clean(old.name, 120), importance: 0.9, confidence: 1, created_at: now, last_seen_at: now }];
  if (old.company) facts.push({ type: 'company', value: clean(old.company, 120), importance: 0.95, confidence: 0.9, created_at: now, last_seen_at: now });
  for (const item of old.preferences || []) facts.push({ type: 'preference', value: clean(item), importance: 0.82, confidence: 0.7, created_at: now, last_seen_at: now });
  for (const item of old.objections || []) facts.push({ type: 'objection', value: clean(item), importance: 0.62, confidence: 0.7, created_at: now, last_seen_at: now });
  if (old.last_outcome) facts.push({ type: 'outcome', value: clean(old.last_outcome, 120), importance: 0.7, confidence: 1, created_at: now, last_seen_at: now });
  return facts.filter((fact) => fact.value);
}

async function ensureProspect(name) {
  const key = keyFor(name);
  if (!key) return null;
  const database = await openDatabase();
  const existing = await transaction(database, 'prospects', 'readonly', (store) => store.get(key));
  if (existing) return existing;
  const legacy = await loadLegacyProfile(key);
  const migrated = { key, name: clean(name, 120), semantic_facts: legacyToFacts(legacy, Date.now()), updated_at: Date.now() };
  if (!migrated.semantic_facts.length) return migrated;
  const writeDb = await openDatabase();
  await transaction(writeDb, 'prospects', 'readwrite', (store) => store.put(migrated));
  return migrated;
}

export async function getProspectMemory(name, query = '') {
  const key = keyFor(name);
  if (!key || !('indexedDB' in window)) return null;
  const profile = await ensureProspect(name);
  const database = await openDatabase();
  const episodes = await transaction(database, 'episodes', 'readonly', (store) => store.index('prospect_key').getAll(key)) || [];
  const now = Date.now();
  const semantic = rankSemanticFacts(profile?.semantic_facts || [], query, now);
  const episodic = episodes
    .map((episode) => ({ ...episode, confidence: confidenceOf(episode, episode.summary ? 0.75 : 0.4), effective_importance: Number((episode.importance * Math.exp(-Math.max(0, now - episode.created_at) / (120 * DAY))).toFixed(3)), relevance: relevance(`${episode.summary} ${episode.objections || ''}`, query) }))
    .filter((episode) => episode.effective_importance >= 0.05)
    .sort((a, b) => {
      const rank = (episode) => episode.relevance * 0.45 + episode.effective_importance * 0.35 + episode.confidence * 0.2;
      return rank(b) - rank(a);
    })
    .slice(0, 4);
  const byType = (type) => semantic.filter((fact) => fact.type === type).map((fact) => fact.value);
  return {
    name: clean(name, 120),
    company: byType('company')[0] || '',
    preferences: byType('preference'),
    objections: byType('objection'),
    last_outcome: byType('outcome')[0] || '',
    semantic_facts: semantic.map(({ type, value, confidence, effective_importance }) => ({ type, value, importance: effective_importance, confidence: Number(confidence.toFixed(2)) })),
    episodic_memory: episodic.map(({ date, summary, status, next_steps, confidence, effective_importance }) => ({ date, summary, status, next_steps, importance: effective_importance, confidence: Number(confidence.toFixed(2)) }))
  };
}

export async function rememberProspect(name, summary, outcome, episodeId) {
  const key = keyFor(name);
  if (!key || !('indexedDB' in window)) return;
  const now = Date.now();
  const prior = await ensureProspect(name) || { key, name: clean(name, 120), semantic_facts: [] };
  const extracted = summary?.prospect_memory || {};
  const candidates = [
    { type: 'name', value: clean(name, 120), importance: 0.92, confidence: 1 },
    extracted.company && { type: 'company', value: clean(extracted.company, 120), importance: 0.96, confidence: 0.9 },
    summary?.customer_needs && summary.customer_needs !== 'Not clearly established.' && { type: 'need', value: clean(summary.customer_needs), importance: 0.86, confidence: 0.8 },
    ...(extracted.preferences || []).map((value) => ({ type: 'preference', value: clean(value), importance: 0.86, confidence: 0.8 })),
    ...(extracted.objections || []).map((value) => ({ type: 'objection', value: clean(value), importance: 0.68, confidence: 0.8 })),
    summary?.objections && summary.objections !== 'No clear objection raised.' && { type: 'objection', value: clean(summary.objections), importance: 0.6, confidence: 0.65 },
    (outcome || summary?.status) && { type: 'outcome', value: clean(outcome || summary.status, 120), importance: 0.72, confidence: 1 }
  ].filter((fact) => fact?.value);
  const byValue = new Map((prior.semantic_facts || []).map((fact) => [`${fact.type}:${fact.value.toLocaleLowerCase()}`, fact]));
  for (const candidate of candidates) {
    const id = `${candidate.type}:${candidate.value.toLocaleLowerCase()}`;
    const existing = byValue.get(id);
    byValue.set(id, { ...existing, ...candidate, importance: Math.max(candidate.importance, existing?.importance || 0), confidence: Math.max(candidate.confidence, existing?.confidence || 0), created_at: existing?.created_at || now, last_seen_at: now, occurrences: (existing?.occurrences || 0) + 1 });
  }
  const facts = uniqueFacts([...byValue.values()]).filter((fact) => decay(fact, now) >= 0.06 || now - fact.last_seen_at < 45 * DAY);
  const profile = { key, name: clean(name, 120), semantic_facts: facts, updated_at: now };
  const episode = { id: episodeId || crypto.randomUUID(), prospect_key: key, created_at: now, date: new Date(now).toISOString(), summary: clean(summary?.summary, 600), objections: clean(summary?.objections, 300), status: clean(outcome || summary?.status, 80), next_steps: clean(summary?.next_steps, 300), importance: summary?.buying_signals?.length ? 0.92 : summary?.status === 'Converted' || summary?.status === 'Demo Requested' ? 0.9 : 0.72, confidence: summary?.summary ? 0.82 : 0.4 };
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = database.transaction(['prospects', 'episodes'], 'readwrite');
    tx.objectStore('prospects').put(profile);
    tx.objectStore('episodes').put(episode);
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onerror = () => { database.close(); reject(tx.error); };
  });
}

export async function clearProspectMemory() {
  if (!('indexedDB' in window)) return;
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = database.transaction(['prospects', 'episodes'], 'readwrite');
    tx.objectStore('prospects').clear(); tx.objectStore('episodes').clear();
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onerror = () => { database.close(); reject(tx.error); };
  });
}
