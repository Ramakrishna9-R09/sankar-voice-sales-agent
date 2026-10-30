// Dependency-free acoustic VAD: adaptive RMS + onset debounce + hangover.
// Web Speech still supplies transcription; this detector only manages turn timing and interruption.
export class EnergyVAD {
  constructor({ onSpeechStart = () => {}, onSpeechEnd = () => {}, onLevel = () => {}, calibrationMs = 700, hangoverMs = 420 } = {}) {
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onLevel = onLevel;
    this.calibrationMs = calibrationMs;
    this.hangoverMs = hangoverMs;
    this.active = false;
    this.samples = [];
    this.frame = 0;
    this.speechFrames = 0;
    this.lastSpeechAt = 0;
    this.noiseFloor = 0.003;
  }
  start(context, stream) {
    if (this.frame || !context || !stream) return;
    this.startedAt = performance.now();
    this.source = context.createMediaStreamSource(stream);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;
    this.data = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    const sample = () => {
      this.analyser.getFloatTimeDomainData(this.data);
      let sum = 0;
      for (let i = 0; i < this.data.length; i += 1) sum += this.data[i] * this.data[i];
      const rms = Math.sqrt(sum / this.data.length);
      const now = performance.now();
      if (!this.active && now - this.startedAt < this.calibrationMs) {
        this.samples.push(rms);
        if (this.samples.length > 60) this.samples.shift();
        if (this.samples.length > 5) this.noiseFloor = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
      } else if (!this.active && rms < this.noiseFloor * 2) {
        this.noiseFloor = this.noiseFloor * 0.985 + rms * 0.015;
      }
      const threshold = Math.max(0.011, Math.min(0.065, this.noiseFloor * 2.8 + 0.006));
      const speechLike = rms >= threshold;
      this.onLevel(Math.min(1, rms / Math.max(threshold * 3, 0.04)), speechLike);
      if (speechLike) {
        this.lastSpeechAt = now;
        this.speechFrames += 1;
        if (!this.active && this.speechFrames >= 3) { this.active = true; this.onSpeechStart({ rms, threshold }); }
      } else {
        this.speechFrames = 0;
        if (this.active && now - this.lastSpeechAt >= this.hangoverMs) { this.active = false; this.onSpeechEnd({ rms, threshold }); }
      }
      this.frame = requestAnimationFrame(sample);
    };
    this.frame = requestAnimationFrame(sample);
  }
  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    try { this.source?.disconnect(); this.analyser?.disconnect(); } catch { /* released with the call audio context */ }
    this.active = false;
  }
}
