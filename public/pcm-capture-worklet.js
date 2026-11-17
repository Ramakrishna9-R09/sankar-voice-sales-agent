// Capture speech as compact 16 kHz mono PCM. The AudioWorklet never sends data
// while VAD is quiet; a short pre-roll preserves the utterance onset.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.samples = [];
    this.preRoll = [];
    this.phase = 0;
    this.samplesPerChunk = 1600; // 100 ms at 16 kHz
    this.ratio = sampleRate / 16000;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== 'speech') return;
      if (data.active && !this.active) {
        this.active = true;
        this.samples = this.preRoll;
        this.preRoll = [];
        this.flush();
      } else if (!data.active) {
        this.active = false;
        this.flush();
      }
    };
  }

  flush() {
    while (this.samples.length >= this.samplesPerChunk) {
      const batch = this.samples.splice(0, this.samplesPerChunk);
      const pcm = new Int16Array(batch.length);
      for (let i = 0; i < batch.length; i += 1) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(batch[i] * (batch[i] < 0 ? 32768 : 32767))));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const output = this.active ? this.samples : this.preRoll;
    for (let i = 0; i < channel.length; i += 1) {
      this.phase += 16000;
      if (this.phase >= sampleRate) { output.push(channel[i]); this.phase -= sampleRate; }
    }
    if (!this.active && this.preRoll.length > 3200) this.preRoll.splice(0, this.preRoll.length - 3200);
    if (this.active) this.flush();
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
