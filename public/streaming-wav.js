// Incrementally extracts PCM16 frames from a RIFF/WAVE response. The TTS adapters
// return WAV today; this keeps the browser from waiting for the whole file download.
export class WavPcmStreamParser {
  constructor() {
    this.pending = new Uint8Array(0);
    this.format = null;
    this.dataRemaining = 0;
    this.frameTail = new Uint8Array(0);
  }

  push(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!this.format || this.dataRemaining === 0) {
      this.pending = concatBytes(this.pending, bytes);
      if (!this.format) this.readHeader();
      if (!this.format || this.dataRemaining === 0) return { format: this.format, pcm: new Uint8Array(0) };
      const audio = this.pending;
      this.pending = new Uint8Array(0);
      return { format: this.format, pcm: this.readPcm(audio) };
    }
    return { format: this.format, pcm: this.readPcm(bytes) };
  }

  readHeader() {
    const bytes = this.pending;
    if (bytes.length < 12) return;
    if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
      throw new Error('TTS audio is not a RIFF/WAVE stream.');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let format = null;
    while (offset + 8 <= bytes.length) {
      const name = readAscii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const body = offset + 8;
      if (name === 'fmt ') {
        if (size < 16) throw new Error('TTS WAV has an invalid format chunk.');
        if (body + 16 > bytes.length) return;
        format = {
          encoding: view.getUint16(body, true),
          channels: view.getUint16(body + 2, true),
          sampleRate: view.getUint32(body + 4, true),
          blockAlign: view.getUint16(body + 12, true),
          bitsPerSample: view.getUint16(body + 14, true)
        };
      }
      if (name === 'data') {
        if (!format) throw new Error('TTS WAV is missing its format chunk.');
        if (format.encoding !== 1 || ![1, 2].includes(format.channels) || format.bitsPerSample !== 16 || format.blockAlign !== format.channels * 2 || format.sampleRate < 8000 || format.sampleRate > 96000) {
          throw new Error('TTS WAV uses an unsupported PCM format.');
        }
        this.format = format;
        this.dataRemaining = size;
        this.pending = bytes.subarray(body);
        return;
      }
      const next = body + size + (size & 1);
      if (next > bytes.length) return;
      offset = next;
    }
  }

  readPcm(bytes) {
    const size = Math.min(bytes.length, this.dataRemaining);
    this.dataRemaining -= size;
    const payload = concatBytes(this.frameTail, bytes.subarray(0, size));
    const alignedSize = payload.length - (payload.length % this.format.blockAlign);
    this.frameTail = payload.subarray(alignedSize);
    if (alignedSize === 0) return new Uint8Array(0);
    return payload.slice(0, alignedSize);
  }
}

export function pcm16ToMonoFloat(bytes, channels) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / (channels * 2));
  for (let frame = 0; frame < samples.length; frame += 1) {
    let value = 0;
    for (let channel = 0; channel < channels; channel += 1) value += view.getInt16((frame * channels + channel) * 2, true) / 32768;
    samples[frame] = value / channels;
  }
  return samples;
}

function readAscii(bytes, offset, length) {
  let value = '';
  for (let i = offset; i < offset + length; i += 1) value += String.fromCharCode(bytes[i]);
  return value;
}

function concatBytes(left, right) {
  if (!left.length) return right.slice();
  if (!right.length) return left.slice();
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}
