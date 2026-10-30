import { executeTool, validateToolArguments, validateToolResult } from './tools.js';
import { logEvent, observeTool } from './observability.js';
import { retryTransient } from './reliability.js';

const READ_ONLY = new Set(['check_product_info', 'calculate_pricing', 'generate_quote']);

async function runOne(call, requestId, signal) {
  const { name, arguments: rawArgs = '', id } = call;
  const startedAt = Date.now();
  if (typeof rawArgs !== 'string' || rawArgs.length > 4000) return { id, name, ok: false, content: { error: 'Tool arguments exceeded the allowed size.' }, elapsedMs: Date.now() - startedAt };
  let args;
  try { args = JSON.parse(rawArgs || '{}'); }
  catch { return { id, name, ok: false, content: { error: 'Tool arguments were not valid JSON.' }, elapsedMs: Date.now() - startedAt }; }
  const validation = validateToolArguments(name, args);
  if (!validation.ok) return { id, name, ok: false, content: { error: validation.error }, elapsedMs: Date.now() - startedAt };
  try {
    const { result, checked } = await retryTransient(async () => {
      const result = await executeTool(name, validation.value, { idempotencyKey: id, context: call.context });
      const checked = validateToolResult(name, result);
      if (!checked.ok) { const error = new Error(checked.error); error.status = 502; throw error; }
      return { result, checked };
    }, { retries: 1, signal, onRetry: (attempt) => logEvent('tool_retry', { request_id: requestId, tool: name, attempt }) });
    return { id, name, ok: !result.error, content: checked.value, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { id, name, ok: false, content: { error: 'Tool execution failed safely. Do not claim the requested action succeeded.' }, elapsedMs: Date.now() - startedAt, error: error.message };
  }
}

export async function executeToolBatch(calls, { requestId, signal, context = {} } = {}) {
  const start = Date.now();
  // Run catalog reads together; serialize stateful actions and restore model-request order in tool messages.
  const contextualCalls = calls.map((call) => ({ ...call, context }));
  const readResults = await Promise.all(contextualCalls.filter((call) => READ_ONLY.has(call.name)).map((call) => runOne(call, requestId, signal)));
  const statefulResults = [];
  for (const call of contextualCalls.filter((call) => !READ_ONLY.has(call.name))) statefulResults.push(await runOne(call, requestId, signal));
  const byId = new Map([...readResults, ...statefulResults].map((result) => [result.id, result]));
  const ordered = calls.map((call) => byId.get(call.id));
  for (const result of ordered) {
    observeTool(result.name, result.ok, result.elapsedMs);
    logEvent('tool_complete', { request_id: requestId, tool: result.name, ok: result.ok, elapsed_ms: result.elapsedMs, result_bytes: Buffer.byteLength(JSON.stringify(result.content), 'utf8') });
  }
  logEvent('tool_batch_complete', { request_id: requestId, count: ordered.length, elapsed_ms: Date.now() - start });
  return ordered;
}
