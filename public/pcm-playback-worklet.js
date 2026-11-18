class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.segments = [];
    this.totalWritten = 0;
    this.position = 0;
    this.sourceRate = sampleRate;
    this.playing = false;
    this.ended = false;
    this.started = false;
    this.drained = false;
    this.stopped = false;
    this.port.onmessage = ({ data }) => this.handleMessage(data);
  }

  handleMessage(message) {
    if (message?.type === 'reset') {
      this.segments = [];
      this.totalWritten = 0;
      this.position = 0;
      this.sourceRate = message.sampleRate || sampleRate;
      this.playing = false;
      this.ended = false;
      this.started = false;
      this.drained = false;
      this.stopped = false;
    } else if (message?.type === 'audio' && message.samples instanceof ArrayBuffer) {
      const samples = new Float32Array(message.samples);
      if (samples.length) {
        this.segments.push({ start: this.totalWritten, samples });
        this.totalWritten += samples.length;
        this.port.postMessage({ type: 'buffered', samples: this.totalWritten - Math.floor(this.position) });
      }
    } else if (message?.type === 'play') this.playing = true;
    else if (message?.type === 'end') this.ended = true;
    else if (message?.type === 'stop') {
      this.segments = [];
      this.position = this.totalWritten;
      this.stopped = true;
      this.port.postMessage({ type: 'stopped' });
    }
  }

  sampleAt(index) {
    while (this.segments.length && index >= this.segments[0].start + this.segments[0].samples.length) this.segments.shift();
    const segment = this.segments[0];
    if (segment && index >= segment.start) return segment.samples[index - segment.start];
    const next = this.segments[1];
    if (next && index >= next.start) return next.samples[index - next.start];
    return 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (this.stopped || !this.playing) return true;
    const step = this.sourceRate / sampleRate;
    for (let i = 0; i < output.length; i += 1) {
      const index = Math.floor(this.position);
      if (index >= this.totalWritten || (index + 1 >= this.totalWritten && !this.ended)) break;
      const first = this.sampleAt(index);
      const second = index + 1 < this.totalWritten ? this.sampleAt(index + 1) : first;
      output[i] = first + (second - first) * (this.position - index);
      this.position += step;
      if (!this.started) { this.started = true; this.port.postMessage({ type: 'started' }); }
    }
    while (this.segments.length && this.segments[0].start + this.segments[0].samples.length <= Math.floor(this.position)) this.segments.shift();
    if (this.ended && !this.drained && this.position >= this.totalWritten) {
      this.drained = true;
      this.port.postMessage({ type: 'drained' });
    }
    return true;
  }
}

registerProcessor('pcm-playback', PcmPlaybackProcessor);
