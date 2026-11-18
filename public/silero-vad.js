const ORT_BASE = '/vendor/ort/';
const VAD_BASE = '/vendor/silero/';
const POSITIVE_SPEECH_THRESHOLD = 0.45;
const NEGATIVE_SPEECH_THRESHOLD = 0.30;
let libraryReady;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load the local VAD runtime: ${src}`));
    document.head.append(script);
  });
}

async function ensureLibrary() {
  if (!libraryReady) {
    libraryReady = (async () => {
      await loadScript(`${ORT_BASE}ort.wasm.min.js`);
      if (!window.ort) throw new Error('ONNX Runtime Web did not initialize.');
      window.ort.env.wasm.wasmPaths = ORT_BASE;
      // Keep browser VAD CPU use predictable; the model is small and runs beside
      // the existing AudioWorklet capture path rather than owning the microphone.
      window.ort.env.wasm.numThreads = 1;
      await loadScript(`${VAD_BASE}bundle.min.js`);
      if (!window.vad?.MicVAD) throw new Error('Silero VAD browser bundle is unavailable.');
    })().catch((error) => {
      libraryReady = null;
      throw error;
    });
  }
  return libraryReady;
}

export async function createSileroVAD({ stream, audioContext, onSpeechStart, onSpeechEnd, onFrameProcessed, onVADMisfire }) {
  if (!stream) throw new Error('A live microphone stream is required for Silero VAD.');
  await ensureLibrary();
  let lastSpeechFrameAt = performance.now();
  const detector = await window.vad.MicVAD.new({
    // Reuse the already consented microphone. The VAD library must not stop or
    // reopen it when paused; call teardown owns track lifetime.
    getStream: async () => stream,
    pauseStream: async () => {},
    resumeStream: async () => stream,
    ...(audioContext ? { audioContext } : {}),
    startOnLoad: false,
    model: 'v5',
    positiveSpeechThreshold: POSITIVE_SPEECH_THRESHOLD,
    negativeSpeechThreshold: NEGATIVE_SPEECH_THRESHOLD,
    redemptionMs: 300,
    preSpeechPadMs: 300,
    minSpeechMs: 160,
    baseAssetPath: VAD_BASE,
    onnxWASMBasePath: ORT_BASE,
    onSpeechStart: () => { lastSpeechFrameAt = performance.now(); onSpeechStart?.(); },
    onSpeechRealStart: () => onSpeechStart?.(),
    onSpeechEnd: (audio) => onSpeechEnd?.(audio, lastSpeechFrameAt),
    onFrameProcessed: (probabilities, frame) => {
      if (probabilities.isSpeech >= NEGATIVE_SPEECH_THRESHOLD) lastSpeechFrameAt = performance.now();
      onFrameProcessed?.(probabilities, frame);
    },
    onVADMisfire: () => onVADMisfire?.(lastSpeechFrameAt)
  });
  detector.start();
  return detector;
}
