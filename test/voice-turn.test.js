import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelVoiceGeneration } from '../public/voice-turn.js';

test('barge-in aborts LLM and TTS, clears queued speech, and drops stale partial text synchronously', () => {
  const llm = new AbortController();
  const tts = new AbortController();
  const partial = { role: 'assistant', content: 'unfinished sentence' };
  let paused = false;
  let removedSource = false;
  let stoppedWorklet = false;
  const state = {
    speaking: true, thinking: true, speechGeneration: 4, speechQueue: [{ text: 'next sentence' }], autoEndCall: true,
    turnController: llm, speechController: tts, streamMessage: partial, messages: [partial],
    audioElement: { pause() { paused = true; }, removeAttribute(name) { removedSource = name === 'src'; } },
    playbackNode: { port: { postMessage(message) { stoppedWorklet = message.type === 'stop'; } } }
  };
  let renders = 0;
  assert.equal(cancelVoiceGeneration(state, () => { renders += 1; }), true);
  assert.equal(llm.signal.aborted, true);
  assert.equal(tts.signal.aborted, true);
  assert.equal(state.speechQueue.length, 0);
  assert.equal(state.speechGeneration, 5);
  assert.equal(state.messages.length, 0);
  assert.equal(renders, 1);
  assert.equal(paused && removedSource, true);
  assert.equal(stoppedWorklet, true);
  assert.equal(cancelVoiceGeneration(state), false);
});
