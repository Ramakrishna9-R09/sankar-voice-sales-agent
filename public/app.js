import { clearProspectMemory, getProspectMemory, rememberProspect } from './memory.js';

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
    toastTimer: null, audioUrl: null, currentAudio: null, filter: 'all', search: '',
    stage: 'introduction', intent: 'neutral', memory: null, turnController: null, turnSequence: 0,
    streamMessage: null, speechQueue: [], speechQueueActive: false, speechGeneration: 0, speechController: null,
    interimText: '', vadTimer: null, autoEndCall: false, suggestedStatus: '', toolActions: []
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
        title.textContent = 'Ready for a real conversation'; description.textContent = `${health.chatModel} · Groq Orpheus voice · streaming agent`;
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

  function renderEvaluation(evaluation) {
    if (!evaluation) return '';
    const metrics = [
      ['Discovery quality', evaluation.discovery_quality],
      ['Objection handling', evaluation.objection_handling_quality],
      ['Overall effectiveness', evaluation.overall_sales_effectiveness]
    ];
    const ratio = evaluation.talk_to_listen_ratio || {};
    const improvement = (evaluation.suggested_improvements || []).slice(0, 3).map((item) => `<p class="evaluation-note">${escapeHTML(item)}</p>`).join('');
    return `<div class="evaluation-block"><div class="evaluation-title"><span>CALL EVALUATION</span><span>${Math.round(Number(ratio.prospect_percent) || 0)}% prospect / ${Math.round(Number(ratio.assistant_percent) || 0)}% assistant</span></div>${metrics.map(([label, score]) => { const value = Math.max(0, Math.min(10, Number(score) || 0)); return `<div class="evaluation-score-row"><span>${label}</span><strong>${value}/10</strong><div class="evaluation-score-track"><i style="width:${value * 10}%"></i></div></div>`; }).join('')}${improvement}</div>`;
  }

  function showSummary(summary) {
    $('#summary-state').textContent = summary.evaluation ? 'EVALUATED' : 'AI ANALYZED';
    const signals = (summary.buying_signals || []).length ? `<div class="summary-line"><strong>BUYING SIGNALS</strong>${escapeHTML(summary.buying_signals.join(' · '))}</div>` : '';
    const actions = (summary.tool_actions || []).map((action) => action.name === 'schedule_followup' ? `Follow-up requested: ${action.requested_time || 'time not specified'}${action.booked ? ' · booked' : ' · needs manual confirmation'}` : action.name === 'generate_quote' || action.name === 'calculate_pricing' ? action.available ? `Verified quote: ${action.currency || ''} ${action.total} ${action.billing_period || ''}` : 'Pricing requires sales confirmation' : action.name === 'update_lead_status' ? `Lead status updated: ${action.status}` : '').filter(Boolean);
    const actionLine = actions.length ? `<div class="summary-line"><strong>CAPTURED ACTIONS</strong>${escapeHTML(actions.join(' · '))}</div>` : '';
    $('#summary-content').innerHTML = `<div class="summary-data"><div class="summary-line"><strong>CALL SUMMARY</strong>${escapeHTML(summary.summary || 'Summary not available.')}</div><div class="summary-line"><strong>CUSTOMER NEEDS</strong>${escapeHTML(summary.customer_needs || 'Not clearly established.')}</div><div class="summary-line"><strong>OBJECTIONS</strong>${escapeHTML(summary.objections || 'No clear objection raised.')}</div><div class="summary-line"><strong>NEXT STEPS</strong>${escapeHTML(summary.next_steps || 'Follow up with the prospect.')}</div>${signals}${actionLine}${renderEvaluation(summary.evaluation)}</div>`;
    const status = summary.status || summary.lead_status || 'Interested';
    const cls = status === 'Interested' ? 'interested' : status === 'Demo Requested' ? 'demo' : status === 'Follow-up Required' ? 'followup' : status === 'Not Interested' ? 'not-interested' : status === 'No Response' ? 'no-response' : '';
    $('#sales-status').innerHTML = `<span class="status-pill ${cls}">${escapeHTML(status)}</span><p class="status-note">${escapeHTML(summary.next_steps || 'Follow up with the prospect.')}</p>`;
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

  const stageNames = { introduction: 'INTRODUCTION', discovery: 'DISCOVERY', pitch: 'VALUE PITCH', objection_handling: 'OBJECTION HANDLING', closing: 'CLOSING', summary_generation: 'SUMMARY' };
  function updateAgentStage(stage) {
    state.stage = stage;
    const chip = $('#agent-stage'); chip.textContent = stageNames[stage] || 'DISCOVERY'; chip.hidden = !state.active;
  }
  function updateIntent(intent) {
    state.intent = intent;
    const chip = $('#intent-label');
    chip.textContent = ({ buying_signal: 'BUYING SIGNAL', objection: 'OBJECTION', question: 'QUESTION', neutral: 'NEUTRAL' })[intent] || 'NEUTRAL';
    chip.hidden = !state.active;
  }

  async function speakSentence(text, generation) {
    if (!state.active || generation !== state.speechGeneration || !state.audioElement) return;
    setVoiceState('speaking'); $('#stage-caption').textContent = 'Streaming AI voice · speak any time to interrupt';
    const controller = new AbortController(); state.speechController = controller;
    try {
      const response = await api('/api/speech', { text }, { raw: true, signal: controller.signal });
      if (!state.active || generation !== state.speechGeneration) return;
      const blob = await response.blob();
      if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
      state.audioUrl = URL.createObjectURL(blob);
      state.audioElement.src = state.audioUrl;
      const ended = new Promise((resolve) => { state.audioElement.onended = resolve; state.audioElement.onerror = resolve; });
      await state.audioElement.play();
      startRecognition(true);
      await ended;
    } catch (error) {
      if (error.name !== 'AbortError' && state.active && generation === state.speechGeneration) {
        showNotice(`Voice generation failed: ${error.message}. The transcript is still available; check Groq model access.`);
        $('#stage-caption').textContent = 'Voice unavailable · listening for the prospect';
        startRecognition();
      }
    } finally { if (state.speechController === controller) state.speechController = null; }
  }

  async function drainSpeechQueue() {
    if (state.speechQueueActive) return;
    state.speechQueueActive = true;
    const generation = state.speechGeneration;
    while (state.speechQueue.length && state.active && generation === state.speechGeneration) {
      await speakSentence(state.speechQueue.shift(), generation);
    }
    state.speechQueueActive = false;
    if (state.speechQueue.length && state.active) { queueMicrotask(drainSpeechQueue); return; }
    if (state.active && generation === state.speechGeneration) {
      setVoiceState(state.thinking ? 'thinking' : 'listening');
      if (!state.thinking) { $('#stage-caption').textContent = 'Listening for the prospect'; startRecognition(); }
      if (state.autoEndCall) { state.autoEndCall = false; await finishCall(); }
    }
  }
  function enqueueSpeech(text) {
    if (!text || !state.active) return;
    state.speechQueue.push(text);
    setVoiceState('speaking');
    if (!state.speechQueueActive) void drainSpeechQueue();
  }

  function interruptAssistant() {
    if (!state.speaking && !state.thinking) return;
    state.speechGeneration += 1; state.speechQueue = []; state.autoEndCall = false;
    state.turnController?.abort(); state.turnController = null; state.speechController?.abort(); state.speechController = null; state.thinking = false; state.speaking = false;
    if (state.streamMessage) {
      state.messages = state.messages.filter((message) => message !== state.streamMessage);
      state.streamMessage = null; renderMessages();
    }
    if (state.audioElement) { state.audioElement.pause(); state.audioElement.removeAttribute('src'); }
    if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
    setVoiceState('listening'); $('#stage-caption').textContent = 'Assistant paused · listening to the prospect';
  }

  async function requestTurn(instruction = '') {
    const turnId = ++state.turnSequence;
    state.turnController?.abort(); state.turnController = new AbortController();
    state.thinking = true; setVoiceState('thinking'); $('#stage-caption').textContent = 'Thinking through the prospect’s response';
    try {
      const response = await fetch('/api/turn/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: state.turnController.signal,
        body: JSON.stringify({ prospect: state.prefs.prospect, product: state.prefs.product, goal: state.prefs.goal, language: state.prefs.language, stage: state.stage, memory: state.memory, instruction, messages: state.messages.map(({ role, content, internal }) => ({ role, content, internal })) })
      });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Request failed (${response.status})`); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      const processFrame = (frame) => {
        const line = frame.split(/\r?\n/).find((part) => part.startsWith('data:'));
        if (!line || turnId !== state.turnSequence) return;
        let event; try { event = JSON.parse(line.slice(5).trim()); } catch { return; }
        if (event.type === 'stage') updateAgentStage(event.stage);
        else if (event.type === 'intent') updateIntent(event.intent);
        else if (event.type === 'delta') {
          if (!state.streamMessage) {
            state.streamMessage = { role: 'assistant', content: '', time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()) };
            state.messages.push(state.streamMessage);
          }
          state.streamMessage.content += event.text;
          renderMessages();
        } else if (event.type === 'sentence') enqueueSpeech(event.text);
        else if (event.type === 'tool') {
          $('#stage-caption').textContent = ({ check_product_info: 'Checking verified product information', calculate_pricing: 'Checking verified pricing', generate_quote: 'Preparing a verified quote', schedule_followup: 'Capturing follow-up request', update_lead_status: 'Updating lead outcome', end_call: 'Wrapping up the call' })[event.name] || 'Working on the next step';
          if (event.action) state.toolActions.push(event.action);
        }
        else if (event.type === 'lead_status') state.suggestedStatus = event.status;
        else if (event.type === 'action' && event.action === 'end_call') { state.autoEndCall = true; try { state.recognizer?.stop(); } catch { /* stop best-effort */ } }
        else if (event.type === 'error') throw new Error(event.error || 'AI request failed.');
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || '';
        for (const frame of frames) processFrame(frame);
        if (done) break;
      }
      if (buffer.trim()) processFrame(buffer);
      if (turnId === state.turnSequence) { state.streamMessage = null; renderMessages(); }
    } catch (error) {
      if (error.name !== 'AbortError' && turnId === state.turnSequence && state.active) {
        if (!state.streamMessage) addMessage('assistant', 'I’m sorry, I’m having trouble connecting right now. Could you repeat that in a moment, or would you prefer a follow-up?');
        showNotice(`AI response failed: ${error.message}`); toast('The AI response could not be completed. You can try speaking again.');
      }
    } finally {
      if (turnId === state.turnSequence) {
        state.thinking = false; state.turnController = null;
        if (state.active && !state.speechQueueActive && !state.speechQueue.length) {
          if (state.autoEndCall) { state.autoEndCall = false; void finishCall(); }
          else { setVoiceState('listening'); $('#stage-caption').textContent = 'Listening for the prospect'; startRecognition(); }
        }
      }
    }
  }

  function submitUtterance(text) {
    const words = String(text || '').trim();
    if (!words || !state.active || state.ending) return;
    if (state.thinking && !state.speaking) return; // Ignore a late final STT event after the VAD silence timer submitted the same phrase.
    clearTimeout(state.vadTimer); state.vadTimer = null; state.interimText = '';
    if (state.speaking || state.thinking) interruptAssistant();
    state.thinking = true;
    try { state.recognizer?.stop(); } catch { /* already stopped */ }
    state.recognizer = null; addMessage('user', words); updateIntent('neutral'); setVoiceState('thinking');
    void requestTurn();
  }

  function startRecognition(duringAssistant = false) {
    if (!state.active || (!duringAssistant && state.thinking) || !SpeechRecognition || state.recognizer) return;
    const recognizer = new SpeechRecognition(); state.recognizer = recognizer;
    recognizer.lang = 'en-IN'; recognizer.continuous = true; recognizer.interimResults = true; recognizer.maxAlternatives = 1;
    recognizer.onstart = () => { if (!state.speaking) setVoiceState('listening'); };
    recognizer.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          const words = result[0].transcript.trim();
          if (words && state.active) { submitUtterance(words); return; }
        } else interim += result[0].transcript;
      }
      if (interim.trim()) {
        state.interimText = interim.trim();
        if (state.speaking || state.thinking) interruptAssistant();
        $('#stage-caption').textContent = `Hearing: “${state.interimText.slice(0, 90)}”`;
        clearTimeout(state.vadTimer);
        state.vadTimer = setTimeout(() => { if (state.interimText && state.active) submitUtterance(state.interimText); }, 850);
      }
    };
    recognizer.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        showNotice('Microphone permission was denied. Allow microphone access in the browser, then restart the call.');
        finishCall();
      } else if (event.error === 'network') showNotice('Speech recognition lost its connection. Check the network and try again.');
    };
    recognizer.onend = () => {
      if (state.recognizer === recognizer) state.recognizer = null;
      if (state.active && !state.thinking) setTimeout(() => startRecognition(state.speaking), 280);
    };
    try { recognizer.start(); } catch { state.recognizer = null; setTimeout(() => startRecognition(state.speaking), 500); }
  }

  function showNotice(text) { const el = $('#call-notice'); el.textContent = text; el.hidden = false; }

  async function startCall() {
    $('#call-notice').hidden = true;
    if (!state.configured) { await checkService(); if (!state.configured) { openModal('settings-modal'); return; } }
    if (!SpeechRecognition) { showNotice('Live speech recognition is not available in this browser. Open the app in Chrome or Edge on localhost or HTTPS.'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { showNotice('This browser cannot access a microphone. Use a secure localhost or HTTPS connection.'); return; }
    state.messages = []; state.stage = 'introduction'; state.intent = 'neutral'; state.memory = null; state.suggestedStatus = ''; state.toolActions = []; state.speechQueue = []; state.autoEndCall = false;
    renderMessages(); resetInsights(); $('#call-timer').textContent = '00:00'; updateAgentStage(state.stage); updateIntent(state.intent);
    $('#start-call').disabled = true;
    try {
      if (state.prefs.prospect) {
        try { state.memory = await getProspectMemory(state.prefs.prospect); }
        catch { state.memory = null; showNotice('Returning-prospect memory could not be loaded; this call will continue without it.'); }
      }
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      setCallState(true);
      updateAgentStage(state.stage); updateIntent(state.intent);
      if ($('#record-consent').checked) {
        if (!window.MediaRecorder) { showNotice('This browser does not support recording. The conversation can continue without recording.'); $('#record-consent').checked = false; }
        else await createAudioGraph(true);
      } else await createAudioGraph(false);
      const returning = state.memory?.last_outcome ? `This is a returning prospect. Use the local memory discreetly; do not repeat old objections unless relevant. Previous outcome: ${state.memory.last_outcome}.` : '';
      await requestTurn(`Open the call with a brief natural greeting, introduce yourself as Sankar Group’s AI sales assistant, say you would like to understand the prospect’s situation, and ask one friendly discovery question. Do not make up product facts. ${returning}`);
    } catch (error) {
      showNotice(error.message || 'The call could not be started. Check microphone permission and server configuration.');
      if (state.active || state.stream) await finishCall(true);
      else { $('#start-call').disabled = false; setVoiceState('ready'); }
    }
  }

  async function buildSummary() {
    $('#summary-state').textContent = 'ANALYZING';
    try {
      const summary = await api('/api/summarize', { product: state.prefs.product, prospect: state.prefs.prospect, messages: state.messages.map((m) => ({ role: m.role, content: m.content })), actions: state.toolActions });
      showSummary(summary); return summary;
    } catch (error) {
      const summary = { summary: `AI summary could not be generated: ${error.message}`, customer_needs: 'Review the transcript', objections: 'Review the transcript', next_steps: 'Check the AI service and retry', status: state.messages.some((m) => m.role === 'user') ? 'Interested' : 'No Response', buying_signals: [], tool_actions: state.toolActions, evaluation: { discovery_quality: 0, objection_handling_quality: 0, overall_sales_effectiveness: 0, talk_to_listen_ratio: { prospect_percent: 0, assistant_percent: 0 }, suggested_improvements: ['Retry call analysis from the service after checking the connection.'] } };
      showSummary(summary); return summary;
    }
  }

  async function finishCall(silent = false) {
    if ((!state.active && !state.stream) || state.ending) return;
    state.ending = true; state.turnSequence += 1; state.turnController?.abort(); state.turnController = null;
    updateAgentStage('summary_generation');
    clearTimeout(state.vadTimer); state.vadTimer = null; state.speechGeneration += 1; state.speechQueue = []; state.autoEndCall = false;
    state.speechController?.abort(); state.speechController = null;
    if (state.streamMessage) { state.messages = state.messages.filter((message) => message !== state.streamMessage); state.streamMessage = null; renderMessages(); }
    setCallState(false); $('#state-label').textContent = 'SAVING'; $('#start-call').disabled = true; $('#end-call').disabled = true;
    $('#agent-stage').hidden = true; $('#intent-label').hidden = true;
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
    if (state.suggestedStatus) summary.status = state.suggestedStatus;
    showSummary(summary);
    try { await rememberProspect(state.prefs.prospect, summary, summary.status); }
    catch { showNotice('Call analysis was saved, but prospect memory could not be updated in this browser.'); }
    const call = {
      id: callId, date: Date.now(), duration: Math.floor((Date.now() - state.startedAt) / 1000),
      prospect: state.prefs.prospect || 'New prospect', product: state.prefs.product || 'Your product', goal: state.prefs.goal,
      messages: cleanMessages, summary, actions: state.toolActions, status: summary.status, audio: audioSaved
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
    renderAnalytics();
    const host = $('#history-cards');
    if (!calls.length) {
      host.innerHTML = state.calls.length ? '<div class="history-empty"><div class="history-empty-icon">⌕</div><strong>No matching conversations</strong><p>Try a different name, product or outcome.</p></div>' : '<div class="history-empty"><div class="history-empty-icon">▤</div><strong>No conversations yet</strong><p>Once you finish a call, its recording, transcript, summary and outcome will be saved here.</p></div>';
      return;
    }
    host.innerHTML = calls.map((call) => `<article class="history-row"><div class="history-person"><span class="history-avatar">${escapeHTML((call.prospect || 'P')[0].toUpperCase())}</span><div><strong>${escapeHTML(call.prospect)}</strong><span>${escapeHTML(dateLabel(call.date))} · ${secondsLabel(call.duration || 0)}</span></div></div><div class="history-col"><span>PRODUCT</span><strong>${escapeHTML(call.product)}</strong></div><div class="history-col"><span>SUMMARY</span><strong>${escapeHTML(call.summary?.next_steps || 'Open call summary')}</strong></div><div class="history-col"><span>OUTCOME</span><strong><span class="status-pill ${statusClass(call.status)}">${escapeHTML(call.status)}</span></strong></div><div class="history-actions">${call.audio ? `<button class="history-action" data-play-call="${escapeHTML(call.id)}" title="Play call recording" aria-label="Play recording">▶</button>` : ''}<button class="history-action" data-open-call="${escapeHTML(call.id)}" title="Open transcript and analysis" aria-label="Open call details">↗</button><button class="history-action" data-delete-call="${escapeHTML(call.id)}" title="Delete call" aria-label="Delete call">×</button></div></article>`).join('');
  }

  function renderAnalytics() {
    const strip = $('#analytics-strip');
    if (!state.calls.length) { strip.innerHTML = ''; return; }
    const scored = state.calls.map((call) => call.summary?.evaluation).filter(Boolean);
    const average = (field) => scored.length ? (scored.reduce((sum, item) => sum + (Number(item[field]) || 0), 0) / scored.length).toFixed(1) : '—';
    const objections = state.calls.map((call) => String(call.summary?.objections || '').trim()).filter((item) => item && item !== 'No clear objection raised.');
    const objectionCounts = new Map(); objections.forEach((item) => objectionCounts.set(item, (objectionCounts.get(item) || 0) + 1));
    const common = [...objectionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'No recurring objection yet';
    const converted = state.calls.filter((call) => call.status === 'Converted').length;
    const conversion = `${Math.round(converted / state.calls.length * 100)}%`;
    strip.innerHTML = `<div class="analytics-item"><span>Average effectiveness</span><strong>${average('overall_sales_effectiveness')}${scored.length ? '/10' : ''}</strong><small>Across ${scored.length} evaluated call${scored.length === 1 ? '' : 's'}</small></div><div class="analytics-item"><span>Discovery quality</span><strong>${average('discovery_quality')}${scored.length ? '/10' : ''}</strong><small>Average evaluator score</small></div><div class="analytics-item"><span>Objection handling</span><strong>${average('objection_handling_quality')}${scored.length ? '/10' : ''}</strong><small>Average evaluator score</small></div><div class="analytics-item"><span>Conversion rate</span><strong>${conversion}</strong><small>${converted} converted of ${state.calls.length} calls</small></div><div class="analytics-item"><span>Common objection</span><strong title="${escapeHTML(common)}">${escapeHTML(common.length > 28 ? `${common.slice(0, 27)}…` : common)}</strong><small>${objections.length} objection record${objections.length === 1 ? '' : 's'}</small></div>`;
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
      let memoryCleared = true;
      try { await clearProspectMemory(); } catch { memoryCleared = false; }
      state.calls = []; saveCalls(); renderHistory(); renderRecent();
      toast(memoryCleared ? 'Call history, recordings, and prospect memory cleared from this browser.' : 'Call history was cleared, but prospect memory could not be removed.');
    });
    $$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
    $$('.modal-layer').forEach((layer) => layer.addEventListener('click', (event) => { if (event.target === layer) closeModal(layer.id); }));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $$('.modal-layer').forEach((layer) => { layer.hidden = true; }); });
    window.addEventListener('beforeunload', () => { try { state.recognizer?.stop(); state.stream?.getTracks().forEach((track) => track.stop()); } catch { /* best effort */ } });
  }

  init();
})();
