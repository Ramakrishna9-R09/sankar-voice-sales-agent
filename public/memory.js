const DB_NAME = 'sankar.voice.prospects.v1';

function openDatabase() {
  return new Promise((resolve, reject) => {
    // Keep prospect data in its own database so existing recording stores need no schema migration.
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('prospects')) database.createObjectStore('prospects', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const prospectKey = (name) => String(name || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const unique = (values, limit = 8) => [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].slice(0, limit);

export async function getProspectMemory(name) {
  const key = prospectKey(name);
  if (!key || !('indexedDB' in window)) return null;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction('prospects').objectStore('prospects').get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function rememberProspect(name, summary, outcome) {
  const key = prospectKey(name);
  if (!key || !('indexedDB' in window)) return;
  const prior = await getProspectMemory(name) || { key, name: String(name).trim(), objections: [], preferences: [] };
  const profile = summary?.prospect_memory || {};
  const record = {
    ...prior,
    name: String(name).trim(),
    company: profile.company || prior.company || '',
    objections: unique([...(prior.objections || []), ...(profile.objections || []), ...(summary?.objections && summary.objections !== 'No clear objection raised.' ? [summary.objections] : [])]),
    preferences: unique([...(prior.preferences || []), ...(profile.preferences || [])]),
    last_outcome: outcome || summary?.status || prior.last_outcome || '',
    last_contact_at: Date.now()
  };
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('prospects', 'readwrite');
    tx.objectStore('prospects').put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearProspectMemory() {
  if (!('indexedDB' in window)) return;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('prospects', 'readwrite');
    tx.objectStore('prospects').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
