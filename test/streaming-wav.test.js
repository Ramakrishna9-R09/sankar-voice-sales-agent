import test from 'node:test';
import assert from 'node:assert/strict';
import { pcm16ToMonoFloat, WavPcmStreamParser } from '../public/streaming-wav.js';

function makeWav({ channels = 1, sampleRate = 24000, samples = [0, 16384, -16384] } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * 2, 8); fmt.writeUInt16LE(channels * 2, 12); fmt.writeUInt16LE(16, 14);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  const fmtHeader = Buffer.alloc(8); fmtHeader.write('fmt ', 0); fmtHeader.writeUInt32LE(fmt.length, 4);
  const dataHeader = Buffer.alloc(8); dataHeader.write('data', 0); dataHeader.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, fmtHeader, fmt, dataHeader, data]);
}

test('WAV parser accepts headers split across transport chunks and emits PCM incrementally', () => {
  const wav = makeWav();
  const parser = new WavPcmStreamParser();
  const first = parser.push(wav.subarray(0, 31));
  const second = parser.push(wav.subarray(31, 47));
  const third = parser.push(wav.subarray(47));
  assert.equal(first.pcm.length, 0);
  assert.equal(second.format.sampleRate, 24000);
  assert.equal(second.format.channels, 1);
  const pcm = Buffer.concat([Buffer.from(second.pcm), Buffer.from(third.pcm)]);
  assert.deepEqual([...pcm], [...wav.subarray(44)]);
  assert.deepEqual([...pcm16ToMonoFloat(pcm, 1)], [0, 0.5, -0.5]);
});

test('WAV parser downmixes stereo PCM16 frames without dropping split sample bytes', () => {
  const wav = makeWav({ channels: 2, samples: [16384, -16384, 32767, 32767] });
  const parser = new WavPcmStreamParser();
  const headerAndFirstByte = parser.push(wav.subarray(0, 45));
  const remainder = parser.push(wav.subarray(45));
  assert.equal(headerAndFirstByte.pcm.length, 0);
  assert.deepEqual([...pcm16ToMonoFloat(remainder.pcm, 2)], [0, 32767 / 32768]);
});

test('WAV parser rejects non-PCM or non-WAV input', () => {
  const parser = new WavPcmStreamParser();
  assert.throws(() => parser.push(new TextEncoder().encode('not-a-wave-file')), /RIFF\/WAVE/);
});
