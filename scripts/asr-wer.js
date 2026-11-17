import fs from 'node:fs/promises';
import { evaluateAsrSamples } from '../agent/wer.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run eval:wer -- path/to/asr-samples.json');
  process.exitCode = 2;
} else {
  try {
    const samples = JSON.parse(await fs.readFile(input, 'utf8'));
    const report = evaluateAsrSamples(samples);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`ASR evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
