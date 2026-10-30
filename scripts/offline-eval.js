import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyIntent, nextStage } from '../agent/stages.js';
import { normalizeEvaluation, talkListenRatio } from '../agent/evaluation.js';
import { validateToolArguments, validateToolResult } from '../agent/tools.js';
import { CircuitBreaker, retryTransient } from '../agent/reliability.js';
import { rankSemanticFacts } from '../public/memory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.resolve(process.argv[2] && process.argv[2] !== '--rescore' ? process.argv[2] : path.join(root, 'eval', 'fixtures.json'));
const rescore = process.argv.includes('--rescore');
const baseUrl = (process.env.EVAL_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const outputPath = process.env.EVAL_OUTPUT || path.join(root, 'eval', 'latest-report.json');
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error('Evaluation input must be a non-empty JSON array.');
assert.equal(validateToolArguments('calculate_pricing', { product: 'Example SaaS', quantity: 2 }).ok, true, 'valid quote arguments should pass');
assert.equal(validateToolArguments('calculate_pricing', { product: 'Example SaaS', total: 1 }).ok, false, 'model-supplied quote totals must be rejected');
assert.equal(validateToolResult('schedule_followup', { booked: 'yes' }).ok, false, 'malformed scheduling results must be rejected');
const memoryNow = Date.now();
const rankedFacts = rankSemanticFacts([
  { type: 'need', value: 'workflow reporting', importance: 0.8, confidence: 0.3, last_seen_at: memoryNow },
  { type: 'need', value: 'workflow reporting', importance: 0.8, confidence: 0.95, last_seen_at: memoryNow }
], 'workflow', memoryNow);
assert.equal(rankedFacts[0].confidence, 0.95, 'higher-confidence facts should win ties in relevance and importance');
let clock = 1000;
const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 500, now: () => clock });
breaker.failure(); breaker.failure();
assert.equal(breaker.state, 'open', 'repeated failures should open the circuit');
clock += 501;
breaker.assertAvailable();
assert.equal(breaker.state, 'half-open', 'cooldown should allow a half-open probe');
breaker.success();
assert.equal(breaker.state, 'closed', 'successful probe should close the circuit');
let openCircuitAttempts = 0;
await assert.rejects(() => retryTransient(() => { openCircuitAttempts += 1; const error = new Error('open'); error.name = 'CircuitOpenError'; error.status = 503; throw error; }, { retries: 2 }));
assert.equal(openCircuitAttempts, 1, 'an open circuit should fail fast without consuming retry attempts');

const results = [];
for (const fixture of fixtures) {
  const latestUser = [...(fixture.messages || [])].reverse().find((message) => message.role === 'user')?.content || '';
  const intent = classifyIntent(latestUser);
  const stage = nextStage('discovery', fixture.messages || [], intent);
  assert.equal(intent, fixture.expected_intent, `${fixture.id}: intent regression`);
  assert.equal(stage, fixture.expected_stage, `${fixture.id}: stage regression`);
  const localEvaluation = normalizeEvaluation({ status: fixture.expected_status, evaluation: { discovery_quality: 5, objection_handling_quality: 5, overall_sales_effectiveness: 5 } }, fixture.messages || []);
  assert.equal(localEvaluation.evaluation.talk_to_listen_ratio.prospect_percent + localEvaluation.evaluation.talk_to_listen_ratio.assistant_percent, 100, `${fixture.id}: talk/listen ratio regression`);
  let judge = null;
  if (rescore) {
    const response = await fetch(`${baseUrl}/api/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: fixture.product, prospect: fixture.prospect, messages: fixture.messages, actions: fixture.actions || [] })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${fixture.id}: ${data.error || `HTTP ${response.status}`}`);
    judge = data;
    console.log(`${fixture.id}: intent=${intent} · stage=${stage} · judge=${data.status} · effectiveness=${data.evaluation?.overall_sales_effectiveness ?? 'n/a'}/10`);
} else console.log(`${fixture.id}: intent=${intent} · stage=${stage} · talk/listen=${talkListenRatio(fixture.messages || []).prospect_percent}/${talkListenRatio(fixture.messages || []).assistant_percent} · deterministic checks passed`);
  results.push({ id: fixture.id, intent, stage, local_evaluation: localEvaluation, ...(judge ? { judge } : {}) });
}
const report = { generated_at: new Date().toISOString(), mode: rescore ? 'groq-rescore' : 'offline-regression', fixture_count: results.length, results };
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Report saved to ${outputPath}`);
