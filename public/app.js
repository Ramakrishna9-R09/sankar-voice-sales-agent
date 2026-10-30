import { clearProspectMemory, getProspectMemory, rememberProspect } from './memory.js';
import { EnergyVAD } from './voice-activity.js';

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
    chunks: [], audioContext: null, audioDestination: null, audioElement: null, vad: null, vadActive: false,
    audioNode: null, messages: [], calls: [], prefs: { ...DEFAULTS },
    toastTimer: null, audioUrl: null, currentAudio: null, filter: 'all', search: '',
    stage: 'introduction', intent: 'neutral', memory: null, turnController: null, turnSequence: 0,
    streamMessage: null, speechQueue: [], speechQueueActive: false, speechGeneration: 0, speechController: null,
    interimText: '', vadTimer: null, autoEndCall: false, suggestedStatus: '', toolActions: [],
    humanControl: false, openedCallId: null, playbackCallId: null, activeTurnStats: null,
    callMetrics: null, metricsRefreshTimer: null
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
    $('#takeover-call').disabled = !active || state.ending;
    if (!active) { $('#takeover-call').hidden = false; $('#resume-ai').hidden = true; $('#operator-panel').hidden = true; }
    else { $('#takeover-call').hidden = state.humanControl; $('#resume-ai').hidden = !state.humanControl; $('#operator-panel').hidden = !state.humanControl; }
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

  function setVADActive(active, level = 0) {
    state.vadActive = active;
    const indicator = $('#vad-indicator');
    indicator.hidden = !active;
    indicator.style.setProperty('--vad-level', String(Math.max(0, Math.min(1, level))));
    $('#assistant-stage').classList.toggle('vad-active', active);
  }

  function renderMessages() {
    const feed = $('#conversation');
    if (!state.messages.length) {
      feed.innerHTML = '<div class="transcript-empty"><div class="empty-symbol">↳</div><strong>The conversation will show up here</strong><p>Start a call. You and your AI assistant will see every turn, as it happens.</p></div>';
      $('#transcript-copy').disabled = true; return;
    }
    feed.innerHTML = state.messages.map((m, index) => {
      const operator = m.role === 'operator';
      const who = m.role === 'user' ? escapeHTML(state.prefs.prospect || 'Prospect') : operator ? 'Human operator' : 'Sankar AI';
      const timestamp = m.offset_ms != null && state.openedCallId && state.playbackCallId === state.openedCallId ? `<button class="turn-time-link" data-seek-call="${escapeHTML(state.openedCallId)}" data-seek-offset="${Number(m.offset_ms) / 1000}">${secondsLabel(Math.floor(Number(m.offset_ms) / 1000))}</button>` : '';
      const active = state.playbackCallId && state.currentAudio && m.offset_ms != null && Math.abs(Number(m.offset_ms) / 1000 - state.currentAudio.currentTime) < 1.2 ? ' active-playback' : '';
      return `<article class="turn ${m.role === 'user' ? 'customer' : operator ? 'operator' : 'assistant'}${active}" data-turn-index="${index}"><div class="turn-avatar">${m.role === 'user' ? 'P' : operator ? 'O' : 'S'}</div><div class="turn-body"><span class="turn-meta">${who} · ${escapeHTML(m.time || '')}${timestamp}</span><div class="turn-bubble">${escapeHTML(m.content)}</div></div></article>`;
    }).join('');
    feed.scrollTop = feed.scrollHeight; $('#transcript-copy').disabled = false;
  }

  function addMessage(role, content) {
    state.messages.push({ role, content, time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()), offset_ms: state.startedAt ? Date.now() - state.startedAt : null });
    renderMessages();
  }

  function freshCallMetrics() {
    return { turns: 0, errors: 0, interruptions: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0, time_to_first_token_ms: [], time_to_first_audio_ms: [], turn_total_ms: [], events: [] };
  }
  function trackCallMetric(name, value) {
    if (!state.callMetrics || !Number.isFinite(value) || value < 0) return;
    if (Array.isArray(state.callMetrics[name])) state.callMetrics[name].push(Math.round(value));
    state.callMetrics.events.push({ name, value_ms: Math.round(value) });
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
      ['Need alignment', evaluation.need_alignment],
      ['Factuality & compliance', evaluation.factuality_and_compliance],
      ['Empathy & tone', evaluation.empathy_and_tone],
      ['Next-step clarity', evaluation.next_step_clarity],
      ['Overall effectiveness', evaluation.overall_sales_effectiveness]
    ];
    const ratio = evaluation.talk_to_listen_ratio || {};
    const improvement = [...(evaluation.strengths || []).map((item) => `Strength: ${item}`), ...(evaluation.suggested_improvements || [])].slice(0, 5).map((item) => `<p class="evaluation-note">${escapeHTML(item)}</p>`).join('');
    return `<div class="evaluation-block"><div class="evaluation-title"><span>CALL EVALUATION</span><span>${Math.round(Number(ratio.prospect_percent) || 0)}% prospect / ${Math.round(Number(ratio.assistant_percent) || 0)}% assistant</span></div>${metrics.map(([label, score]) => { const value = Math.max(0, Math.min(10, Number(score) || 0)); return `<div class="evaluation-score-row"><span>${label}</span><strong>${value}/10</strong><div class="evaluation-score-track"><i style="width:${value * 10}%"></i></div></div>`; }).join('')}${improvement}</div>`;
  }

  function showSummary(summary) {
    $('#summary-state').textContent = summary.evaluation ? 'EVALUATED' : 'AI ANALYZED';
    const signals = (summary.buying_signals || []).length ? `<div class="summary-line"><strong>BUYING SIGNALS</strong>${escapeHTML(summary.buying_signals.join(' · '))}</div>` : '';
    const risks = (summary.risk_flags || []).length ? `<div class="summary-line"><strong>QUALITY FLAGS</strong>${escapeHTML(summary.risk_flags.join(' · '))}</div>` : '';
    const actions = (summary.tool_actions || []).map((action) => action.name === 'schedule_followup' ? `Follow-up requested: ${action.requested_time || 'time not specified'}${action.booked ? ' · booked' : ' · needs manual confirmation'}` : action.name === 'generate_quote' || action.name === 'calculate_pricing' ? action.available ? `Verified quote: ${action.currency || ''} ${action.total} ${action.billing_period || ''}` : 'Pricing requires sales confirmation' : action.name === 'update_lead_status' ? `Lead status updated: ${action.status}` : '').filter(Boolean);
    const actionLine = actions.length ? `<div class="summary-line"><strong>CAPTURED ACTIONS</strong>${escapeHTML(actions.join(' · '))}</div>` : '';
    $('#summary-content').innerHTML = `<div class="summary-data"><div class="summary-line"><strong>CALL SUMMARY</strong>${escapeHTML(summary.summary || 'Summary not available.')}</div><div class="summary-line"><strong>CUSTOMER NEEDS</strong>${escapeHTML(summary.customer_needs || 'Not clearly established.')}</div><div class="summary-line"><strong>OBJECTIONS</strong>${escapeHTML(summary.objections || 'No clear objection raised.')}</div><div class="summary-line"><strong>NEXT STEPS</strong>${escapeHTML(summary.next_steps || 'Follow up with the prospect.')}</div>${signals}${risks}${actionLine}${renderEvaluation(summary.evaluation)}</div>`;
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
    state.vad = new EnergyVAD({
      onSpeechStart: () => {
        setVADActive(true);
        if (state.speaking || state.thinking) interruptAssistant();
      },
      onSpeechEnd: () => {
        setVADActive(false);
        if (state.interimText && state.active && !state.thinking) submitUtterance(state.interimText);
      }
    });
    state.vad.start(state.audioContext, state.stream);
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

  async function speakSentence(text, generation, turnStats) {
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
      if (turnStats && turnStats.firstAudioMs == null) {
        turnStats.firstAudioMs = performance.now() - turnStats.startedAt;
        trackCallMetric('time_to_first_audio_ms', turnStats.firstAudioMs);
      }
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
      const item = state.speechQueue.shift();
      await speakSentence(item.text, generation, item.turnStats);
    }
    state.speechQueueActive = false;
    if (state.speechQueue.length && state.active) { queueMicrotask(drainSpeechQueue); return; }
    if (state.active && generation === state.speechGeneration) {
      setVoiceState(state.thinking ? 'thinking' : 'listening');
      if (!state.thinking) { $('#stage-caption').textContent = 'Listening for the prospect'; startRecognition(); }
      if (state.autoEndCall) { state.autoEndCall = false; await finishCall(); }
    }
  }
  function enqueueSpeech(text, turnStats = state.activeTurnStats) {
    if (!text || !state.active) return;
    state.speechQueue.push({ text, turnStats });
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
    const turnStats = { startedAt: performance.now(), firstTokenMs: null, firstAudioMs: null, serverMetrics: null };
    state.activeTurnStats = turnStats;
    if (state.callMetrics) state.callMetrics.turns += 1;
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
          if (turnStats.firstTokenMs == null) {
            turnStats.firstTokenMs = performance.now() - turnStats.startedAt;
            trackCallMetric('time_to_first_token_ms', turnStats.firstTokenMs);
          }
          if (!state.streamMessage) {
            state.streamMessage = { role: 'assistant', content: '', time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()), offset_ms: state.startedAt ? Date.now() - state.startedAt : null };
            state.messages.push(state.streamMessage);
          }
          state.streamMessage.content += event.text;
          renderMessages();
        } else if (event.type === 'sentence') enqueueSpeech(event.text, turnStats);
        else if (event.type === 'tool') {
          $('#stage-caption').textContent = ({ check_product_info: 'Checking verified product information', calculate_pricing: 'Checking verified pricing', generate_quote: 'Preparing a verified quote', schedule_followup: 'Capturing follow-up request', update_lead_status: 'Updating lead outcome', end_call: 'Wrapping up the call' })[event.name] || 'Working on the next step';
          if (event.action) state.toolActions.push(event.action);
          if (state.callMetrics) state.callMetrics.tool_calls += 1;
        }
        else if (event.type === 'turn_metrics') {
          turnStats.serverMetrics = event;
          if (state.callMetrics) { state.callMetrics.input_tokens += Number(event.input_tokens) || 0; state.callMetrics.output_tokens += Number(event.output_tokens) || 0; }
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
      trackCallMetric('turn_total_ms', performance.now() - turnStats.startedAt);
      if (turnId === state.turnSequence) { state.streamMessage = null; renderMessages(); }
    } catch (error) {
      if (error.name !== 'AbortError' && state.callMetrics) state.callMetrics.errors += 1;
      if (error.name === 'AbortError' && state.callMetrics) state.callMetrics.interruptions += 1;
      if (error.name !== 'AbortError' && turnId === state.turnSequence && state.active) {
        const fallback = 'I’m sorry, I’m having trouble connecting right now. Could you repeat that in a moment, or would you prefer a follow-up?';
        state.streamMessage = null;
        addMessage('assistant', fallback);
        enqueueSpeech(fallback, null);
        showNotice(`AI response failed: ${error.message}`); toast('The AI response could not be completed. You can try speaking again.');
      }
    } finally {
      if (turnId === state.turnSequence) {
        state.thinking = false; state.turnController = null;
        if (state.activeTurnStats === turnStats) state.activeTurnStats = null;
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
    try { state.recognizer?.stop(); } catch { /* already stopped */ }
    state.recognizer = null; addMessage('user', words); updateIntent('neutral');
    if (state.humanControl) { state.thinking = false; setVoiceState('listening', 'Human operator has control.'); startRecognition(); return; }
    state.thinking = true; setVoiceState('thinking');
    void requestTurn();
  }

  function takeOverCall() {
    if (!state.active || state.ending) return;
    if (state.speaking || state.thinking) interruptAssistant();
    state.humanControl = true;
    $('#takeover-call').hidden = true; $('#resume-ai').hidden = false; $('#operator-panel').hidden = false;
    setVoiceState('listening', 'Human operator has control.'); $('#stage-caption').textContent = 'Human operator in control';
    startRecognition(); $('#operator-message').focus(); toast('AI paused. You can speak to the prospect or send a typed voice response.');
  }

  function resumeAI() {
    if (!state.active || state.ending) return;
    state.humanControl = false;
    $('#takeover-call').hidden = false; $('#resume-ai').hidden = true; $('#operator-panel').hidden = true;
    try { state.recognizer?.stop(); } catch { /* stop best-effort */ }
    state.recognizer = null;
    void requestTurn('A human operator has handed control back. Continue from the complete transcript, acknowledge the most recent operator response if relevant, and do not repeat the introduction.');
  }

  function sendOperatorMessage() {
    const text = $('#operator-message').value.trim();
    if (!text || !state.active || !state.humanControl) return;
    $('#operator-message').value = '';
    try { state.recognizer?.stop(); } catch { /* stop best-effort */ }
    state.recognizer = null;
    addMessage('operator', text);
    enqueueSpeech(text, null);
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
    state.messages = []; state.stage = 'introduction'; state.intent = 'neutral'; state.memory = null; state.suggestedStatus = ''; state.toolActions = []; state.speechQueue = []; state.autoEndCall = false; state.humanControl = false; state.callMetrics = freshCallMetrics(); state.openedCallId = null; state.playbackCallId = null;
    renderMessages(); resetInsights(); $('#call-timer').textContent = '00:00'; updateAgentStage(state.stage); updateIntent(state.intent);
    $('#start-call').disabled = true;
    try {
      if (state.prefs.prospect) {
        try { state.memory = await getProspectMemory(state.prefs.prospect, `${state.prefs.product} ${state.prefs.goal}`); }
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
    state.vad?.stop(); state.vad = null; setVADActive(false);
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
    try { await rememberProspect(state.prefs.prospect, summary, summary.status, callId); }
    catch { showNotice('Call analysis was saved, but prospect memory could not be updated in this browser.'); }
    if (state.callMetrics?.events?.length) {
      try {
        for (let i = 0; i < state.callMetrics.events.length; i += 40) await api('/api/telemetry', { events: state.callMetrics.events.slice(i, i + 40) });
      } catch { /* telemetry is best-effort and must not delay local call saving */ }
    }
    const call = {
      id: callId, date: Date.now(), duration: Math.floor((Date.now() - state.startedAt) / 1000),
      prospect: state.prefs.prospect || 'New prospect', product: state.prefs.product || 'Your product', goal: state.prefs.goal,
      messages: cleanMessages, summary, actions: state.toolActions, metrics: state.callMetrics, status: summary.status, audio: audioSaved
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
    host.innerHTML = calls.map((call) => `<article class="history-row${state.playbackCallId === call.id ? ' active-playback' : ''}"><div class="history-person"><span class="history-avatar">${escapeHTML((call.prospect || 'P')[0].toUpperCase())}</span><div><strong>${escapeHTML(call.prospect)}</strong><span>${escapeHTML(dateLabel(call.date))} · ${secondsLabel(call.duration || 0)}</span></div></div><div class="history-col"><span>PRODUCT</span><strong>${escapeHTML(call.product)}</strong></div><div class="history-col"><span>SUMMARY</span><strong>${escapeHTML(call.summary?.next_steps || 'Open call summary')}</strong></div><div class="history-col"><span>OUTCOME</span><strong><span class="status-pill ${statusClass(call.status)}">${escapeHTML(call.status)}</span></strong></div><div class="history-actions">${call.audio ? `<button class="history-action" data-play-call="${escapeHTML(call.id)}" title="Play call recording" aria-label="Play recording">▶</button>` : ''}<button class="history-action" data-open-call="${escapeHTML(call.id)}" title="Open transcript and analysis" aria-label="Open call details">↗</button><button class="history-action" data-rescore-call="${escapeHTML(call.id)}" title="Re-score this call" aria-label="Re-score call">↻</button><button class="history-action" data-delete-call="${escapeHTML(call.id)}" title="Delete call" aria-label="Delete call">×</button></div></article>`).join('');
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
    const percentile50 = (values) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? `${Math.round(sorted[Math.floor((sorted.length - 1) * 0.5)])} ms` : '—'; };
    const firstTokens = state.calls.flatMap((call) => call.metrics?.time_to_first_token_ms || []);
    const firstAudio = state.calls.flatMap((call) => call.metrics?.time_to_first_audio_ms || []);
    strip.innerHTML = `<div class="analytics-item"><span>Average effectiveness</span><strong>${average('overall_sales_effectiveness')}${scored.length ? '/10' : ''}</strong><small>Across ${scored.length} evaluated call${scored.length === 1 ? '' : 's'}</small></div><div class="analytics-item"><span>Discovery quality</span><strong>${average('discovery_quality')}${scored.length ? '/10' : ''}</strong><small>Average evaluator score</small></div><div class="analytics-item"><span>Objection handling</span><strong>${average('objection_handling_quality')}${scored.length ? '/10' : ''}</strong><small>Average evaluator score</small></div><div class="analytics-item"><span>Conversion rate</span><strong>${conversion}</strong><small>${converted} converted of ${state.calls.length} calls</small></div><div class="analytics-item"><span>Median first token</span><strong>${percentile50(firstTokens)}</strong><small>Saved call measurements</small></div><div class="analytics-item"><span>Median first audio</span><strong>${percentile50(firstAudio)}</strong><small>Saved call measurements</small></div><div class="analytics-item"><span>Common objection</span><strong title="${escapeHTML(common)}">${escapeHTML(common.length > 28 ? `${common.slice(0, 27)}…` : common)}</strong><small>${objections.length} objection record${objections.length === 1 ? '' : 's'}</small></div>`;
  }

  async function refreshMetrics() {
    const host = $('#ops-metrics');
    try {
      const metrics = await api('/api/metrics', null, { method: 'GET' });
      const fmt = (value) => value == null ? '—' : `${Math.round(value)} ms`;
      const tools = Object.values(metrics.tools || {});
      const toolCalls = tools.reduce((sum, item) => sum + item.calls, 0);
      const toolErrors = tools.reduce((sum, item) => sum + item.errors, 0);
      const toolSuccess = toolCalls ? `${Math.round((toolCalls - toolErrors) / toolCalls * 100)}%` : '—';
      host.innerHTML = `<div class="ops-metric"><span>Time to first token · p50</span><strong>${fmt(metrics.voice?.time_to_first_token_ms?.p50_ms)}</strong></div><div class="ops-metric"><span>Time to first audio · p50</span><strong>${fmt(metrics.voice?.time_to_first_audio_ms?.p50_ms)}</strong></div><div class="ops-metric"><span>Turn latency · p95</span><strong>${fmt(metrics.turns?.p95_ms)}</strong></div><div class="ops-metric"><span>Groq request errors</span><strong>${Math.round((metrics.groq?.error_rate || 0) * 100)}%</strong></div><div class="ops-metric"><span>Tool success rate</span><strong>${toolSuccess}</strong></div><div class="ops-metric"><span>Tokens · input / output</span><strong>${Number(metrics.groq?.input_tokens || 0).toLocaleString()} / ${Number(metrics.groq?.output_tokens || 0).toLocaleString()}</strong></div>`;
      $('#metrics-scope').textContent = `${metrics.scope || 'Instance-local'} · circuit ${metrics.circuit?.state || 'unknown'} · window resets after 15 minutes.`;
    } catch {
      host.innerHTML = '<div class="ops-metric"><span>Runtime telemetry</span><strong>Unavailable</strong></div>';
      $('#metrics-scope').textContent = 'Metrics endpoint is unavailable. Call handling is unaffected.';
    }
  }

  async function openCall(callId) {
    const call = state.calls.find((item) => item.id === callId); if (!call) return;
    state.openedCallId = call.id;
    state.messages = call.messages || []; state.prefs = { ...state.prefs, prospect: call.prospect, product: call.product, goal: call.goal || DEFAULTS.goal };
    updateBrief(); renderMessages(); showSummary(call.summary || { status: call.status, summary: 'No analysis saved.', next_steps: 'Review the transcript.' });
    document.querySelector('#workspace').scrollIntoView({ behavior: 'smooth' }); toast('Saved transcript and AI analysis loaded.');
  }

  async function playCall(callId, button) {
    const active = state.calls.find((call) => call.id === callId); if (!active) return;
    try {
      const blob = await getAudio(callId); if (!blob) throw new Error('Recording is missing from this browser.');
      if (state.currentAudio) { state.currentAudio.pause(); if (state.playbackUrl) URL.revokeObjectURL(state.playbackUrl); }
      if (state.playbackButton) state.playbackButton.textContent = '▶';
      await openCall(callId);
      state.playbackCallId = callId;
      renderMessages(); renderHistory();
      const url = URL.createObjectURL(blob); const audio = new Audio(url); state.currentAudio = audio; state.playbackUrl = url; state.playbackButton = button;
      button.textContent = 'Ⅱ'; let lastPaint = -1;
      audio.ontimeupdate = () => { const second = Math.floor(audio.currentTime); if (second !== lastPaint) { lastPaint = second; renderMessages(); } };
      audio.onended = () => { button.textContent = '▶'; renderMessages(); };
      audio.onerror = () => { button.textContent = '▶'; toast('This recording could not be played.'); };
      await audio.play();
    } catch (error) { toast(error.message || 'This recording could not be played.'); }
  }

  async function seekRecording(callId, offset) {
    if (state.playbackCallId !== callId || !state.currentAudio) {
      const row = document.querySelector(`[data-play-call="${CSS.escape(callId)}"]`);
      if (row) await playCall(callId, row);
    }
    if (state.currentAudio && state.playbackCallId === callId) {
      state.currentAudio.currentTime = Math.max(0, Number(offset) || 0);
      try { await state.currentAudio.play(); } catch { /* browser may require another user gesture */ }
      renderMessages();
    }
  }

  async function rescoreCall(callId, button) {
    const call = state.calls.find((item) => item.id === callId); if (!call) return;
    button.disabled = true; button.textContent = '…';
    try {
      const summary = await api('/api/evaluate', { product: call.product, prospect: call.prospect, messages: call.messages || [], actions: call.actions || [] });
      call.summary = summary; call.status = summary.status; saveCalls(); renderHistory(); renderRecent();
      if (state.openedCallId === call.id) showSummary(summary);
      toast('Saved call re-evaluated with the current rubric.');
    } catch (error) { toast(`Re-score failed: ${error.message}`); }
    finally { button.disabled = false; button.textContent = '↻'; }
  }

  function exportCallsCSV() {
    const header = ['date', 'prospect', 'product', 'duration_seconds', 'status', 'summary', 'needs', 'objections', 'next_steps', 'discovery_score', 'objection_score', 'overall_score', 'transcript'];
    const cells = state.calls.map((call) => {
      const evaluation = call.summary?.evaluation || {};
      const transcript = (call.messages || []).map((message) => `${message.role === 'user' ? call.prospect : message.role === 'operator' ? 'Human operator' : 'Sankar AI'}: ${message.content}`).join(' | ');
      return [new Date(call.date).toISOString(), call.prospect, call.product, call.duration || 0, call.status, call.summary?.summary, call.summary?.customer_needs, call.summary?.objections, call.summary?.next_steps, evaluation.discovery_quality, evaluation.objection_handling_quality, evaluation.overall_sales_effectiveness, transcript];
    });
    const encode = (value) => {
      let text = String(value ?? '').replace(/[\r\n]+/g, ' ');
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = [header, ...cells].map((row) => row.map(encode).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `sankar-voice-calls-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
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
      try { await navigator.clipboard.writeText(state.messages.filter((m) => !m.internal).map((m) => `${m.role === 'user' ? state.prefs.prospect || 'Prospect' : m.role === 'operator' ? 'Human operator' : 'Sankar AI'}: ${m.content}`).join('\n')); toast('Transcript copied.'); }
      catch { toast('Clipboard access is unavailable in this browser.'); }
    });
    $('#takeover-call').addEventListener('click', takeOverCall);
    $('#resume-ai').addEventListener('click', resumeAI);
    $('#operator-send').addEventListener('click', sendOperatorMessage);
    $('#operator-message').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendOperatorMessage(); } });
    $('#export-csv').addEventListener('click', exportCallsCSV);
    $('#refresh-metrics').addEventListener('click', refreshMetrics);
    $('#history-search').addEventListener('input', (event) => { state.search = event.target.value; renderHistory(); });
    $('#history-filter').addEventListener('change', (event) => { state.filter = event.target.value; renderHistory(); });
    $('#history-cards').addEventListener('click', (event) => {
      const play = event.target.closest('[data-play-call]'); if (play) return playCall(play.dataset.playCall, play);
      const rescore = event.target.closest('[data-rescore-call]'); if (rescore) return rescoreCall(rescore.dataset.rescoreCall, rescore);
      const remove = event.target.closest('[data-delete-call]'); if (remove) { const callId = remove.dataset.deleteCall; if (state.playbackCallId === callId && state.currentAudio) { state.currentAudio.pause(); state.currentAudio = null; state.playbackCallId = null; } state.calls = state.calls.filter((call) => call.id !== callId); removeAudio(callId); saveCalls(); renderHistory(); renderRecent(); toast('Conversation removed from this browser.'); return; }
      const open = event.target.closest('[data-open-call]'); if (open) openCall(open.dataset.openCall);
    });
    $('#conversation').addEventListener('click', (event) => { const seek = event.target.closest('[data-seek-call]'); if (seek) seekRecording(seek.dataset.seekCall, seek.dataset.seekOffset); });
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
    window.addEventListener('beforeunload', () => { try { state.recognizer?.stop(); state.vad?.stop(); state.stream?.getTracks().forEach((track) => track.stop()); } catch { /* best effort */ } });
    await refreshMetrics();
  }

  init();
})();
