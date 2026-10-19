(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const CALLS_KEY = 'sankar.voice.calls.v2';
  const PREFS_KEY = 'sankar.voice.brief.v1';
  const DB_NAME = 'sankar.voice.audio.v1';
  const DEFAULTS = { prospect: '', product: 'Nexus CRM', goal: 'Understand their needs', language: 'English' };
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const state = {
    configured: false, active: false, ending: false, thinking: false, speaking: false,
    startedAt: 0, timer: null, recognizer: null, stream: null, recorder: null,
    chunks: [], audioContext: null, audioDestination: null, audioElement: null,
    audioNode: null, messages: [], calls: [], prefs: { ...DEFAULTS },
    toastTimer: null, audioUrl: null, currentAudio: null, filter: 'all', search: ''
  };

  const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } };
  const secondsLabel = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  const dateLabel = (n) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(n);
  const id = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('visible');
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
  }

  function db() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('recordings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function putAudio(key, blob) {
    const database = await db();
    return new Promise((resolve, reject) => { const tx = database.transaction('recordings', 'readwrite'); tx.objectStore('recordings').put(blob, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  }
  async function getAudio(key) {
    const database = await db();
    return new Promise((resolve, reject) => { const request = database.transaction('recordings').objectStore('recordings').get(key); request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); });
  }
  async function removeAudio(key) {
    try { const database = await db(); database.transaction('recordings', 'readwrite').objectStore('recordings').delete(key); } catch { /* best-effort cleanup */ }
  }

  async function api(path, payload, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'POST', headers: payload ? { 'Content-Type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined, signal: options.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return options.raw ? response : response.json();
  }

  async function checkService() {
    const label = $('#connection-label'), wrap = $('.environment-label'), title = $('#engine-title'), description = $('#engine-description'), card = $('#setup-card');
    try {
      const health = await api('/api/health', null, { method: 'GET' }); state.configured = health.configured;
      if (state.configured) {
        label.textContent = 'AI engine connected'; wrap.className = 'environment-label ready';
        title.textContent = 'Ready for a real conversation'; description.textContent = `${health.chatModel} · Groq Orpheus voice`;
        card.classList.add('connected');
      } else {
        label.textContent = 'AI setup required'; wrap.className = 'environment-label error';
        title.textContent = 'Connect your AI engine'; description.textContent = 'Add a server-side API key to enable AI conversation and voice.';
        card.classList.remove('connected');
      }
    } catch {
      state.configured = false; label.textContent = 'Server unavailable'; wrap.className = 'environment-label error';
      title.textContent = 'Start the app server'; description.textContent = 'Run npm install, configure .env, and start the local server.'; card.classList.remove('connected');
    }
  }

  function saveCalls() {
    try { localStorage.setItem(CALLS_KEY, JSON.stringify(state.calls)); }
    catch { toast('Call list storage is full. Remove older calls to continue saving.'); }
  }

  function setCallState(active) {
    state.active = active;
    $('#start-call').disabled = active || state.ending;
    $('#end-call').disabled = !active || state.ending;
    $('#session-state').classList.toggle('active', active);
    $('#state-label').textContent = state.ending ? 'SAVING' : active ? 'CALL IN PROGRESS' : 'READY';
    $('#transcript-live').hidden = !active;
    $('#assistant-stage').classList.toggle('listening', active && !state.speaking && !state.thinking);
    if (active) {
      state.startedAt = Date.now();
      state.timer = setInterval(() => { $('#call-timer').textContent = secondsLabel(Math.floor((Date.now() - state.startedAt) / 1000)); }, 400);
    } else clearInterval(state.timer);
  }

  function setVoiceState(kind, detail) {
    state.speaking = kind === 'speaking'; state.thinking = kind === 'thinking';
    $('#assistant-stage').classList.toggle('speaking', state.speaking);
    $('#assistant-stage').classList.toggle('listening', kind === 'listening');
    $('#voice-state').textContent = kind === 'speaking' ? 'Assistant is speaking' : kind === 'thinking' ? 'Thinking through your response' : kind === 'listening' ? 'Listening to the prospect' : kind === 'error' ? 'Conversation paused' : 'Your AI sales assistant';
    $('#voice-substate').textContent = detail || (kind === 'speaking' ? 'A clear, natural response is on its way.' : kind === 'thinking' ? 'Finding a helpful, relevant answer.' : kind === 'listening' ? 'Go ahead — the assistant is listening.' : 'A calm, helpful conversation starts here.');
  }

  function renderMessages() {
    const feed = $('#conversation');
    if (!state.messages.length) {
      feed.innerHTML = '<div class="transcript-empty"><div class="empty-symbol">↳</div><strong>The conversation will show up here</strong><p>Start a call. You and your AI assistant will see every turn, as it happens.</p></div>';
      $('#transcript-copy').disabled = true; return;
    }
    feed.innerHTML = state.messages.map((m) => `<article class="turn ${m.role === 'user' ? 'customer' : 'assistant'}"><div class="turn-avatar">${m.role === 'user' ? 'P' : 'S'}</div><div class="turn-body"><span class="turn-meta">${m.role === 'user' ? escapeHTML(state.prefs.prospect || 'Prospect') : 'Sankar AI'} · ${escapeHTML(m.time || '')}</span><div class="turn-bubble">${escapeHTML(m.content)}</div></div></article>`).join('');
    feed.scrollTop = feed.scrollHeight; $('#transcript-copy').disabled = false;
  }

  function addMessage(role, content) {
    state.messages.push({ role, content, time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()) });
    renderMessages();
  }

  function updateBrief() {
    const prospect = state.prefs.prospect || 'New conversation';
    $('#prospect-name').textContent = prospect; $('#prospect-avatar').textContent = prospect === 'New conversation' ? 'P' : prospect.trim()[0].toUpperCase();
    $('#product-name').textContent = state.prefs.product || 'Your product'; $('#goal-value').textContent = state.prefs.goal || DEFAULTS.goal;
  }

  function resetInsights() {
    $('#summary-state').textContent = 'AFTER CALL';
    $('#summary-content').innerHTML = '<div class="summary-empty"><div class="summary-graphic"><i>✳</i><span></span><span></span><span></span></div><strong>Clarity after every call.</strong><p>Needs, objections, buying signals and a practical next step — captured automatically.</p></div>';
    $('#sales-status').innerHTML = '<span class="outcome-mark">—</span><div><strong>Awaiting conversation</strong><p>Your AI will recommend a sales status.</p></div>';
  }

  function showSummary(summary) {
    $('#summary-state').textContent = summary.model ? 'AI ANALYZED' : 'AI ANALYZED';
    $('#summary-content').innerHTML = `<div class="summary-data"><div class="summary-line"><strong>CALL SUMMARY</strong>${escapeHTML(summary.summary || 'Summary not available.')}</div><div class="summary-line"><strong>CUSTOMER NEEDS</strong>${escapeHTML(summary.customer_needs || 'Not clearly established.')}</div><div class="summary-line"><strong>OBJECTIONS</strong>${escapeHTML(summary.objections || 'No clear objection raised.')}</div><div class="summary-line"><strong>NEXT STEPS</strong>${escapeHTML(summary.next_steps || 'Follow up with the prospect.')}</div></div>`;
    const cls = summary.status === 'Interested' ? 'interested' : summary.status === 'Demo Requested' ? 'demo' : summary.status === 'Follow-up Required' ? 'followup' : summary.status === 'Not Interested' ? 'not-interested' : summary.status === 'No Response' ? 'no-response' : '';
    $('#sales-status').innerHTML = `<span class="status-pill ${cls}">${escapeHTML(summary.status || 'Interested')}</span><p class="status-note">${escapeHTML(summary.next_steps || 'Follow up with the prospect.')}</p>`;
  }

  async function createAudioGraph(recordCall) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Audio recording is not supported by this browser.');
    state.audioContext = new Context(); await state.audioContext.resume();
    if (recordCall) {
      state.audioDestination = state.audioContext.createMediaStreamDestination();
      state.audioContext.createMediaStreamSource(state.stream).connect(state.audioDestination);
    }
    state.audioElement = new Audio(); state.audioElement.preload = 'auto';
    state.audioNode = state.audioContext.createMediaElementSource(state.audioElement);
    if (recordCall) {
      state.audioNode.connect(state.audioDestination); state.audioNode.connect(state.audioContext.destination);
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      state.recorder = new MediaRecorder(state.audioDestination.stream, type ? { mimeType: type } : undefined);
      state.chunks = [];
      state.recorder.ondataavailable = (event) => { if (event.data.size) state.chunks.push(event.data); };
      state.recorder.start(1000);
    } else state.audioNode.connect(state.audioContext.destination);
  }

  async function speak(text) {
    if (!state.active) return;
    setVoiceState('speaking'); $('#stage-caption').textContent = 'AI-generated voice response';
    try {
      const response = await api('/api/speech', { text }, { raw: true });
      if (!state.active) return;
      const blob = await response.blob();
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = URL.createObjectURL(blob);
      state.audioElement.src = state.audioUrl;
      await state.audioElement.play();
      await new Promise((resolve) => { state.audioElement.onended = resolve; state.audioElement.onerror = resolve; });
      if (state.active) {
        setVoiceState('listening'); $('#stage-caption').textContent = 'Listening for the prospect';
        startRecognition();
      }
    } catch (error) {
      if (!state.active) return;
      setVoiceState('error', error.message); showNotice(`Voice generation failed: ${error.message}`);
      $('#stage-caption').textContent = 'Voice generation failed';
      toast('AI voice could not be generated. Check the Groq voice configuration.');
    }
  }

  async function requestTurn() {
    try {
      const result = await api('/api/turn', {
        prospect: state.prefs.prospect, product: state.prefs.product, goal: state.prefs.goal, language: state.prefs.language,
        messages: state.messages.map((m) => ({ role: m.role, content: m.content }))
      });
      if (!state.active) return;
      addMessage('assistant', result.reply); await speak(result.reply);
    } catch (error) {
      if (!state.active) return;
      setVoiceState('error', error.message); showNotice(`AI response failed: ${error.message}`);
      toast('The model did not respond. Review the server and API settings.');
      startRecognition();
    }
  }

  function startRecognition() {
    if (!state.active || state.speaking || state.thinking || !SpeechRecognition || state.recognizer) return;
    const recognizer = new SpeechRecognition(); state.recognizer = recognizer;
    recognizer.lang = 'en-IN'; recognizer.continuous = true; recognizer.interimResults = true; recognizer.maxAlternatives = 1;
    recognizer.onstart = () => setVoiceState('listening');
    recognizer.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          const words = result[0].transcript.trim();
          if (words && state.active && !state.thinking) {
            state.thinking = true; $('#stage-caption').textContent = 'Processing the prospect’s response';
            try { recognizer.stop(); } catch { /* already stopped */ }
            state.recognizer = null; addMessage('user', words); setVoiceState('thinking'); requestTurn(); return;
          }
        } else interim += result[0].transcript;
      }
      if (interim) { $('#stage-caption').textContent = `Hearing: “${interim.slice(0, 100)}”`; }
    };
    recognizer.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        showNotice('Microphone permission was denied. Allow microphone access in the browser, then restart the call.');
        finishCall();
      } else if (event.error === 'network') showNotice('Speech recognition lost its connection. Check the network and try again.');
    };
    recognizer.onend = () => {
      if (state.recognizer === recognizer) state.recognizer = null;
      if (state.active && !state.thinking && !state.speaking) setTimeout(startRecognition, 280);
    };
    try { recognizer.start(); } catch { state.recognizer = null; setTimeout(startRecognition, 500); }
  }

  function showNotice(text) { const el = $('#call-notice'); el.textContent = text; el.hidden = false; }

  async function startCall() {
    $('#call-notice').hidden = true;
    if (!state.configured) { await checkService(); if (!state.configured) { openModal('settings-modal'); return; } }
    if (!SpeechRecognition) { showNotice('Live speech recognition is not available in this browser. Open the app in Chrome or Edge on localhost or HTTPS.'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { showNotice('This browser cannot access a microphone. Use a secure localhost or HTTPS connection.'); return; }
    state.messages = []; renderMessages(); resetInsights(); $('#call-timer').textContent = '00:00';
    $('#start-call').disabled = true;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      setCallState(true);
      if ($('#record-consent').checked) {
        if (!window.MediaRecorder) { showNotice('This browser does not support recording. The conversation can continue without recording.'); $('#record-consent').checked = false; }
        else await createAudioGraph(true);
      } else await createAudioGraph(false);
      const request = 'Open the call with a brief natural greeting, introduce yourself as Sankar Group’s AI sales assistant, say you would like to understand the prospect\'s situation, and ask one friendly discovery question. Do not make up product facts.';
      state.messages.push({ role: 'user', content: request, internal: true });
      const result = await api('/api/turn', { prospect: state.prefs.prospect, product: state.prefs.product, goal: state.prefs.goal, language: state.prefs.language, messages: state.messages.map(({ role, content }) => ({ role, content })) });
      state.messages = []; addMessage('assistant', result.reply); await speak(result.reply);
    } catch (error) {
      showNotice(error.message || 'The call could not be started. Check microphone permission and server configuration.');
      if (state.active || state.stream) await finishCall(true);
      else { $('#start-call').disabled = false; setVoiceState('ready'); }
    }
  }

  async function buildSummary() {
    $('#summary-state').textContent = 'ANALYZING';
    try {
      const summary = await api('/api/summarize', { product: state.prefs.product, prospect: state.prefs.prospect, messages: state.messages.map((m) => ({ role: m.role, content: m.content })) });
      showSummary(summary); return summary;
    } catch (error) {
      const summary = { summary: `AI summary could not be generated: ${error.message}`, customer_needs: 'Review the transcript', objections: 'Review the transcript', next_steps: 'Check the AI service and retry', status: state.messages.some((m) => m.role === 'user') ? 'Interested' : 'No Response' };
      showSummary(summary); return summary;
    }
  }

  async function finishCall(silent = false) {
    if ((!state.active && !state.stream) || state.ending) return;
    state.ending = true; setCallState(false); $('#state-label').textContent = 'SAVING'; $('#start-call').disabled = true; $('#end-call').disabled = true;
    try { state.recognizer?.stop(); } catch { /* no active recognizer */ }
    state.recognizer = null;
    if (state.audioElement) { state.audioElement.pause(); state.audioElement.removeAttribute('src'); }
    if (state.stream) { state.stream.getTracks().forEach((track) => track.stop()); state.stream = null; }
    let blob = null;
    if (state.recorder && state.recorder.state !== 'inactive') {
      await new Promise((resolve) => { state.recorder.onstop = () => { blob = new Blob(state.chunks, { type: state.recorder?.mimeType || 'audio/webm' }); resolve(); }; try { state.recorder.stop(); } catch { resolve(); } });
    }
    state.recorder = null;
    try { await state.audioContext?.close(); } catch { /* already closed */ }
    state.audioContext = null; state.audioDestination = null; state.audioNode = null; state.audioElement = null;
    const cleanMessages = state.messages.filter((m) => !m.internal);
    let audioSaved = false; const callId = id();
    if (blob?.size > 1200) { try { await putAudio(callId, blob); audioSaved = true; } catch { showNotice('The transcript was saved, but browser storage could not save the recording.'); } }
    const summary = await buildSummary();
    const call = {
      id: callId, date: Date.now(), duration: Math.floor((Date.now() - state.startedAt) / 1000),
      prospect: state.prefs.prospect || 'New prospect', product: state.prefs.product || 'Your product', goal: state.prefs.goal,
      messages: cleanMessages, summary, status: summary.status, audio: audioSaved
    };
    state.calls.unshift(call); saveCalls(); renderHistory(); renderRecent();
    state.ending = false; $('#start-call').disabled = false; $('#state-label').textContent = 'READY';
    setVoiceState('ready'); $('#stage-caption').textContent = audioSaved ? 'Call and recording saved on this device' : 'Call transcript and analysis saved';
    if (!silent) toast(audioSaved ? 'Call recording, transcript, and analysis saved.' : 'Call transcript and analysis saved.');
  }

  function statusClass(status) {
    return status === 'Interested' ? 'interested' : status === 'Demo Requested' ? 'demo' : status === 'Follow-up Required' ? 'followup' : status === 'Not Interested' ? 'not-interested' : status === 'No Response' ? 'no-response' : '';
  }

  function renderRecent() {
    $('#nav-count').textContent = state.calls.length;
    $('#recent-list').innerHTML = state.calls.slice(0, 8).map((call) => `<div class="recent-item" data-open-call="${escapeHTML(call.id)}"><div class="recent-avatar">${escapeHTML((call.prospect || 'P')[0].toUpperCase())}</div><div class="recent-copy"><strong>${escapeHTML(call.prospect)}</strong><span>${escapeHTML(call.status)} · ${escapeHTML(dateLabel(call.date))}</span></div><span class="recent-indicator"></span></div>`).join('') || '<div class="recent-empty">Calls you finish will appear here.</div>';
  }

  function renderHistory() {
    const query = state.search.toLowerCase();
    const calls = state.calls.filter((call) => (state.filter === 'all' || call.status === state.filter) && (!query || `${call.prospect} ${call.product} ${call.status} ${call.summary?.summary || ''}`.toLowerCase().includes(query)));
    $('#history-count').textContent = calls.length;
    const host = $('#history-cards');
    if (!calls.length) {
      host.innerHTML = state.calls.length ? '<div class="history-empty"><div class="history-empty-icon">⌕</div><strong>No matching conversations</strong><p>Try a different name, product or outcome.</p></div>' : '<div class="history-empty"><div class="history-empty-icon">▤</div><strong>No conversations yet</strong><p>Once you finish a call, its recording, transcript, summary and outcome will be saved here.</p></div>';
      return;
    }
    host.innerHTML = calls.map((call) => `<article class="history-row"><div class="history-person"><span class="history-avatar">${escapeHTML((call.prospect || 'P')[0].toUpperCase())}</span><div><strong>${escapeHTML(call.prospect)}</strong><span>${escapeHTML(dateLabel(call.date))} · ${secondsLabel(call.duration || 0)}</span></div></div><div class="history-col"><span>PRODUCT</span><strong>${escapeHTML(call.product)}</strong></div><div class="history-col"><span>SUMMARY</span><strong>${escapeHTML(call.summary?.next_steps || 'Open call summary')}</strong></div><div class="history-col"><span>OUTCOME</span><strong><span class="status-pill ${statusClass(call.status)}">${escapeHTML(call.status)}</span></strong></div><div class="history-actions">${call.audio ? `<button class="history-action" data-play-call="${escapeHTML(call.id)}" title="Play call recording" aria-label="Play recording">▶</button>` : ''}<button class="history-action" data-open-call="${escapeHTML(call.id)}" title="Open transcript and analysis" aria-label="Open call details">↗</button><button class="history-action" data-delete-call="${escapeHTML(call.id)}" title="Delete call" aria-label="Delete call">×</button></div></article>`).join('');
  }

  async function openCall(callId) {
    const call = state.calls.find((item) => item.id === callId); if (!call) return;
    state.messages = call.messages || []; state.prefs = { ...state.prefs, prospect: call.prospect, product: call.product, goal: call.goal || DEFAULTS.goal };
    updateBrief(); renderMessages(); showSummary(call.summary || { status: call.status, summary: 'No analysis saved.', next_steps: 'Review the transcript.' });
    document.querySelector('#workspace').scrollIntoView({ behavior: 'smooth' }); toast('Saved transcript and AI analysis loaded.');
  }

  async function playCall(callId, button) {
    const active = state.calls.find((call) => call.id === callId); if (!active) return;
    try {
      const blob = await getAudio(callId); if (!blob) throw new Error('Recording is missing from this browser.');
      if (state.currentAudio) { state.currentAudio.pause(); state.currentAudio = null; }
      const url = URL.createObjectURL(blob); const audio = new Audio(url); state.currentAudio = audio;
      button.textContent = 'Ⅱ'; audio.onended = () => { button.textContent = '▶'; URL.revokeObjectURL(url); state.currentAudio = null; };
      audio.onerror = () => { button.textContent = '▶'; toast('This recording could not be played.'); };
      await audio.play();
    } catch (error) { toast(error.message || 'This recording could not be played.'); }
  }

  function openModal(modalId) {
    if (modalId === 'details-modal') {
      $('#input-prospect').value = state.prefs.prospect; $('#input-product').value = state.prefs.product; $('#input-goal').value = state.prefs.goal;
    }
    $('#'+modalId).hidden = false; setTimeout(() => $('#'+modalId+' input, #'+modalId+' textarea')?.focus(), 40);
  }
  function closeModal(modalId) { $('#'+modalId).hidden = true; }
  function saveBrief() {
    state.prefs = { ...state.prefs, prospect: $('#input-prospect').value.trim(), product: $('#input-product').value.trim() || DEFAULTS.product, goal: $('#input-goal').value.trim() || DEFAULTS.goal };
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); updateBrief(); closeModal('details-modal'); toast('Call brief saved on this device.');
  }

  async function init() {
    state.calls = readJSON(CALLS_KEY, []); state.prefs = { ...DEFAULTS, ...readJSON(PREFS_KEY, {}) };
    updateBrief(); renderMessages(); renderHistory(); renderRecent(); resetInsights();
    $('#today-date').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
    await checkService();

    $('#start-call').addEventListener('click', startCall);
    $('#end-call').addEventListener('click', () => finishCall());
    $('#edit-details').addEventListener('click', () => openModal('details-modal'));
    $('#brief-edit').addEventListener('click', () => openModal('details-modal'));
    $('#save-details').addEventListener('click', saveBrief);
    $('#settings-open').addEventListener('click', () => openModal('settings-modal'));
    $('#setup-link').addEventListener('click', () => openModal('settings-modal'));
    $('#transcript-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.messages.filter((m) => !m.internal).map((m) => `${m.role === 'user' ? state.prefs.prospect || 'Prospect' : 'Sankar AI'}: ${m.content}`).join('\n')); toast('Transcript copied.'); }
      catch { toast('Clipboard access is unavailable in this browser.'); }
    });
    $('#history-search').addEventListener('input', (event) => { state.search = event.target.value; renderHistory(); });
    $('#history-filter').addEventListener('change', (event) => { state.filter = event.target.value; renderHistory(); });
    $('#history-cards').addEventListener('click', (event) => {
      const play = event.target.closest('[data-play-call]'); if (play) return playCall(play.dataset.playCall, play);
      const remove = event.target.closest('[data-delete-call]'); if (remove) { const callId = remove.dataset.deleteCall; state.calls = state.calls.filter((call) => call.id !== callId); removeAudio(callId); saveCalls(); renderHistory(); renderRecent(); toast('Conversation removed from this browser.'); return; }
      const open = event.target.closest('[data-open-call]'); if (open) openCall(open.dataset.openCall);
    });
    $('#recent-list').addEventListener('click', (event) => { const open = event.target.closest('[data-open-call]'); if (open) openCall(open.dataset.openCall); });
    $('#clear-history').addEventListener('click', async () => {
      for (const call of state.calls) await removeAudio(call.id);
      state.calls = []; saveCalls(); renderHistory(); renderRecent(); toast('Call history and recordings cleared from this browser.');
    });
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
    $$('.modal-layer').forEach((layer) => layer.addEventListener('click', (event) => { if (event.target === layer) closeModal(layer.id); }));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $$('.modal-layer').forEach((layer) => { layer.hidden = true; }); });
    window.addEventListener('beforeunload', () => { try { state.recognizer?.stop(); state.stream?.getTracks().forEach((track) => track.stop()); } catch { /* best effort */ } });
  }

  init();
})();
