import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const copies = [
  ['node_modules/@ricky0123/vad-web/dist/bundle.min.js', 'public/vendor/silero/bundle.min.js'],
  ['node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'public/vendor/silero/vad.worklet.bundle.min.js'],
  ['node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'public/vendor/silero/silero_vad_v5.onnx'],
  ['node_modules/onnxruntime-web/dist/ort.wasm.min.js', 'public/vendor/ort/ort.wasm.min.js'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'public/vendor/ort/ort-wasm-simd-threaded.mjs'],
  ['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'public/vendor/ort/ort-wasm-simd-threaded.wasm']
];

for (const [source, target] of copies) {
  const destination = join(root, target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, source), destination);
}

console.log(`Prepared ${copies.length} local Silero VAD and ONNX runtime assets.`);
