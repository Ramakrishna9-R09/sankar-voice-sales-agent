const windows = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_SAMPLES = 500;

function bucket(name) {
  const now = Date.now();
  let value = windows.get(name);
  if (!value || now - value.started_at > WINDOW_MS) {
    value = { started_at: now, count: 0, errors: 0, samples: [], tools: {}, input_tokens: 0, output_tokens: 0 };
    windows.set(name, value);
  }
  return value;
}

export function logEvent(event, fields = {}) {
  // Log operational metadata only. Never log transcripts, prompts, credentials, or full tool arguments.
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })); } catch { /* telemetry must not break a call */ }
}

export function observeRequest({ kind, ok, latencyMs, inputTokens = 0, outputTokens = 0 }) {
  const value = bucket(kind);
  value.count += 1;
  if (!ok) value.errors += 1;
  if (Number.isFinite(latencyMs)) value.samples.push(Math.max(0, latencyMs));
  if (value.samples.length > MAX_SAMPLES) value.samples.shift();
  value.input_tokens += Number(inputTokens) || 0;
  value.output_tokens += Number(outputTokens) || 0;
}

export function observeTool(name, ok, latencyMs) {
  const value = bucket('tools');
  const entry = value.tools[name] || { calls: 0, errors: 0, samples: [] };
  entry.calls += 1;
  if (!ok) entry.errors += 1;
  if (Number.isFinite(latencyMs)) entry.samples.push(Math.max(0, latencyMs));
  if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
  value.tools[name] = entry;
}

export function observeTokenUsage(kind, inputTokens, outputTokens) {
  const value = bucket(kind);
  value.input_tokens += Number(inputTokens) || 0;
  value.output_tokens += Number(outputTokens) || 0;
}

export function observeClientEvent(name, valueMs) {
  if (!['time_to_first_audio_byte_ms', 'time_to_first_audio_ms', 'time_to_first_token_ms', 'turn_total_ms', 'interruption_cancel_ms', 'stt_finalize_ms', 'call_started', 'call_dropped', 'barge_in', 'handoff_auto'].includes(name)) return false;
  if (!Number.isFinite(valueMs) || valueMs < 0 || valueMs > 120_000) return false;
  const value = bucket(name);
  value.count += 1;
  value.samples.push(valueMs);
  if (value.samples.length > MAX_SAMPLES) value.samples.shift();
  return true;
}

export function observeClientMetric(name, value) {
  if (name !== 'stt_mean_log_probability' || !Number.isFinite(value) || value < -30 || value > 0) return false;
  const bucketValue = bucket('stt_mean_log_probability');
  bucketValue.count += 1;
  bucketValue.samples.push(value);
  if (bucketValue.samples.length > MAX_SAMPLES) bucketValue.samples.shift();
  return true;
}

function percentileValue(samples, ratio) {
  if (!samples?.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function percentile(samples, ratio) {
  const value = percentileValue(samples, ratio);
  return value == null ? null : Math.round(value);
}

function snapshotBucket(value) {
  return {
    count: value.count,
    errors: value.errors,
    error_rate: value.count ? Number((value.errors / value.count).toFixed(3)) : 0,
    p50_ms: percentile(value.samples, 0.5),
    p95_ms: percentile(value.samples, 0.95),
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens
  };
}

export function metricsSnapshot(circuits, provider = 'groq', speechCircuit) {
  const tools = windows.get('tools')?.tools || {};
  const empty = { count: 0, errors: 0, samples: [], input_tokens: 0, output_tokens: 0 };
  const callStarts = windows.get('call_started')?.count || 0;
  const callDrops = windows.get('call_dropped')?.count || 0;
  const firstAudioSamples = windows.get('time_to_first_audio_ms')?.samples || [];
  const configuredAudioTarget = Number(process.env.VOICE_LATENCY_TARGET_MS);
  const firstAudioTargetMs = Number.isFinite(configuredAudioTarget) && configuredAudioTarget >= 100 && configuredAudioTarget <= 5000 ? configuredAudioTarget : 800;
  const sttLogProbability = percentileValue(windows.get('stt_mean_log_probability')?.samples || [], 0.5);
  return {
    scope: 'current serverless instance; rolling 15-minute window',
    generated_at: new Date().toISOString(),
    provider,
    llm: snapshotBucket(windows.get(provider) || empty),
    groq: snapshotBucket(windows.get('groq') || empty),
    turns: snapshotBucket(windows.get('turns') || { count: 0, errors: 0, samples: [], input_tokens: 0, output_tokens: 0 }),
    speech: snapshotBucket(windows.get('speech') || { count: 0, errors: 0, samples: [], input_tokens: 0, output_tokens: 0 }),
    voice: {
      time_to_first_token_ms: snapshotBucket(windows.get('time_to_first_token_ms') || { count: 0, errors: 0, samples: [], input_tokens: 0, output_tokens: 0 }),
      time_to_first_audio_byte_ms: snapshotBucket(windows.get('time_to_first_audio_byte_ms') || empty),
      time_to_first_audio_ms: snapshotBucket(windows.get('time_to_first_audio_ms') || { count: 0, errors: 0, samples: [], input_tokens: 0, output_tokens: 0 }),
      first_audio_target_ms: firstAudioTargetMs,
      first_audio_target_attainment: firstAudioSamples.length ? Number((firstAudioSamples.filter((sample) => sample <= firstAudioTargetMs).length / firstAudioSamples.length).toFixed(3)) : null,
      turn_total_ms: snapshotBucket(windows.get('turn_total_ms') || empty),
      interruption_cancel_ms: snapshotBucket(windows.get('interruption_cancel_ms') || empty),
      stt_finalize_ms: snapshotBucket(windows.get('stt_finalize_ms') || empty),
      call_starts: callStarts,
      call_drops: callDrops,
      call_drop_rate: callStarts ? Number((callDrops / callStarts).toFixed(3)) : 0,
      barge_in_count: windows.get('barge_in')?.count || 0,
      automatic_handoff_count: windows.get('handoff_auto')?.count || 0
    },
    stt: { mean_log_probability_p50: sttLogProbability == null ? null : Number(sttLogProbability.toFixed(3)), scored_utterances: windows.get('stt_mean_log_probability')?.count || 0, confidence_note: 'Whisper mean log probability is a diagnostic signal, not calibrated confidence; Qwen ASR does not currently expose a comparable score.' },
    tools: Object.fromEntries(Object.entries(tools).map(([name, entry]) => [name, { calls: entry.calls, errors: entry.errors, success_rate: entry.calls ? Number(((entry.calls - entry.errors) / entry.calls).toFixed(3)) : 0, p50_ms: percentile(entry.samples, 0.5) }])),
    circuit: circuits?.[provider]?.snapshot?.() || { state: 'closed', failures: 0, retry_in_ms: 0 },
    speech_circuit: speechCircuit?.snapshot?.() || { state: 'closed', failures: 0, retry_in_ms: 0 }
  };
}

