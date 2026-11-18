import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsSnapshot, observeClientEvent, observeClientMetric, observeTool } from '../agent/observability.js';

test('exposes bounded client audio, STT diagnostic, and tool metrics with target attainment', () => {
  const previousTarget = process.env.VOICE_LATENCY_TARGET_MS;
  process.env.VOICE_LATENCY_TARGET_MS = '400';
  observeClientEvent('time_to_first_audio_ms', 300);
  observeClientEvent('time_to_first_audio_ms', 500);
  observeClientEvent('first_sentence_ms', 240);
  observeClientEvent('tts_request_start_ms', 255);
  observeClientEvent('interruption_audio_stop_ms', 185);
  observeClientEvent('barge_in_stop_success', 1);
  observeClientEvent('barge_in_stop_success', 0);
  observeClientMetric('stt_mean_log_probability', -0.8);
  observeTool('generate_quote', true, 35);
  const metrics = metricsSnapshot({}, 'local');
  assert.equal(metrics.voice.first_audio_target_ms, 400);
  assert.equal(metrics.voice.first_audio_target_attainment, 0.5);
  assert.equal(metrics.voice.first_sentence_ms.p50_ms, 240);
  assert.equal(metrics.voice.tts_request_start_ms.p50_ms, 255);
  assert.equal(metrics.voice.interruption_audio_stop_ms.p50_ms, 185);
  assert.equal(metrics.voice.barge_in_success_rate, 0.5);
  assert.equal(metrics.voice.barge_in_success_samples, 2);
  assert.equal(metrics.stt.mean_log_probability_p50, -0.8);
  assert.equal(metrics.tools.generate_quote.success_rate, 1);
  if (previousTarget == null) delete process.env.VOICE_LATENCY_TARGET_MS;
  else process.env.VOICE_LATENCY_TARGET_MS = previousTarget;
});
