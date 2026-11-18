import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadProcessor() {
  let Processor;
  class AudioWorkletProcessorStub {
    constructor() { this.port = { postMessage: (message) => this.messages.push(message), onmessage: null }; this.messages = []; }
  }
  const context = vm.createContext({
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    registerProcessor: (_name, processor) => { Processor = processor; },
    sampleRate: 48000
  });
  const source = await readFile(new URL('../public/pcm-playback-worklet.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return { Processor, context };
}

test('playback worklet emits audio frames and acknowledges immediate stop', async () => {
  const { Processor, context } = await loadProcessor();
  const processor = new Processor();
  const samples = vm.runInContext('new Float32Array([0, 1]).buffer', context);
  processor.handleMessage({ type: 'reset', sampleRate: 48000 });
  processor.handleMessage({ type: 'audio', samples });
  processor.handleMessage({ type: 'end' });
  processor.handleMessage({ type: 'play' });
  const output = new Float32Array(128);
  processor.process([], [[output]]);
  assert.deepEqual([...output.subarray(0, 2)], [0, 1]);
  assert.equal(processor.messages.some((message) => message.type === 'started'), true);
  assert.equal(processor.messages.some((message) => message.type === 'drained'), true);

  processor.handleMessage({ type: 'stop' });
  const stoppedOutput = new Float32Array(128).fill(1);
  processor.process([], [[stoppedOutput]]);
  assert.equal(stoppedOutput.every((value) => value === 0), true);
  assert.equal(processor.messages.some((message) => message.type === 'stopped'), true);
});
