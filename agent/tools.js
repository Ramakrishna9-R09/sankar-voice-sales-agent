const leadStatuses = ['Converted', 'Interested', 'Follow-up Required', 'Not Interested', 'Demo Requested', 'No Response'];

export const agentTools = [
  {
    type: 'function',
    function: {
      name: 'check_product_info',
      description: 'Look up verified product information. Use this before answering detailed capability or integration questions.',
      parameters: { type: 'object', properties: { product: { type: 'string' }, question: { type: 'string' } }, required: ['product', 'question'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate_pricing',
      description: 'Calculate a quote only from the server configured product catalog. Never invent or infer prices.',
      parameters: { type: 'object', properties: { product: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10000 }, plan: { type: 'string' } }, required: ['product'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_quote',
      description: 'Prepare a pricing quote from the trusted server catalog. If pricing is not configured, explain that a sales representative must confirm it.',
      parameters: { type: 'object', properties: { product: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10000 }, plan: { type: 'string' } }, required: ['product'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_followup',
      description: 'Capture a prospect requested follow-up date and time. The tool does not book an external calendar.',
      parameters: { type: 'object', properties: { requested_time: { type: 'string' }, channel: { type: 'string', enum: ['email', 'phone', 'demo', 'other'] }, notes: { type: 'string' } }, required: ['requested_time'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_lead_status',
      description: 'Set the call outcome based only on evidence from the conversation.',
      parameters: { type: 'object', properties: { status: { type: 'string', enum: leadStatuses }, reason: { type: 'string' } }, required: ['status', 'reason'], additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'end_call',
      description: 'End the sales conversation when the prospect clearly declines or the next step has been agreed and acknowledged.',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false }
    }
  }
];

function catalog() {
  try { return JSON.parse(process.env.GROQ_PRODUCT_CATALOG || '{}'); }
  catch { return {}; }
}

function findProduct(name) {
  const products = catalog();
  const key = Object.keys(products).find((candidate) => candidate.toLowerCase() === String(name || '').toLowerCase());
  return key ? { name: key, ...products[key] } : null;
}

async function postIntegration(urlValue, payload, idempotencyKey) {
  if (!urlValue) return { configured: false };
  let url;
  try { url = new URL(urlValue); } catch { throw new Error('Integration URL is invalid.'); }
  if (url.protocol !== 'https:') throw new Error('Integrations require HTTPS.');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(process.env.INTEGRATION_WEBHOOK_SECRET ? { Authorization: `Bearer ${process.env.INTEGRATION_WEBHOOK_SECRET}` } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Integration returned HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder(); let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('Integration response exceeded the 4 KB limit.'); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try { return { configured: true, data: JSON.parse(text) }; } catch { return { configured: true, data: {} }; }
}

export async function executeTool(name, args = {}, { idempotencyKey, context = {} } = {}) {
  switch (name) {
    case 'check_product_info': {
      const product = findProduct(args.product);
      if (!product) return { found: false, message: 'No verified product catalog entry is configured. Do not guess product capabilities; ask a discovery question or offer a sales follow-up.' };
      return { found: true, product: product.name, description: product.description || '', features: Array.isArray(product.features) ? product.features : [], integrations: Array.isArray(product.integrations) ? product.integrations : [], message: product.description || 'Only the listed features are verified.' };
    }
    case 'calculate_pricing':
    case 'generate_quote': {
      // Never use model-supplied amounts: only server-controlled catalog prices can be quoted.
      const product = findProduct(args.product);
      if (!product || !Number.isFinite(Number(product.price))) return { available: false, message: 'There is no trusted price configured for this product. Do not quote a price; offer to have a sales representative confirm pricing.' };
      const quantity = Math.max(1, Math.min(10000, Math.floor(Number(args.quantity) || 1)));
      const total = Number(product.price) * quantity;
      return { available: true, product: product.name, plan: args.plan || product.plan || 'standard', quantity, unit_price: Number(product.price), currency: product.currency || 'USD', total, billing_period: product.billing_period || 'per unit', message: `Verified catalog price: ${product.currency || 'USD'} ${total.toFixed(2)} ${product.billing_period || 'per unit'} for ${quantity} unit(s).` };
    }
    case 'schedule_followup':
      {
        const followup = { requested_time: String(args.requested_time || '').slice(0, 160), channel: args.channel || 'other', notes: String(args.notes || '').slice(0, 300) };
        const integration = await postIntegration(process.env.FOLLOWUP_WEBHOOK_URL, { ...context, ...followup }, idempotencyKey);
        const booked = integration.configured && integration.data?.booked === true;
        return { captured: true, ...followup, booked, confirmation: booked ? String(integration.data.confirmation || '').slice(0, 180) : '', message: booked ? 'The connected scheduling service confirmed the follow-up.' : 'The prospect requested this follow-up. It has been captured, but no connected service confirmed a booking. Do not claim it is scheduled.' };
      }
    case 'update_lead_status':
      if (!leadStatuses.includes(args.status)) return { updated: false, message: 'Status was not changed because it is outside the supported set.' };
      {
        const status = { status: args.status, reason: String(args.reason || '').slice(0, 300) };
        const integration = await postIntegration(process.env.CRM_WEBHOOK_URL, { ...context, ...status }, idempotencyKey);
        return { updated: true, ...status, synced: integration.configured, message: integration.configured ? 'Lead outcome recorded and sent to the configured CRM webhook.' : 'Lead outcome recorded for this call.' };
      }
    case 'end_call':
      return { end_call: true, reason: String(args.reason || '').slice(0, 240) };
    default:
      return { error: `Unsupported tool: ${name}` };
  }
}

export { leadStatuses };

export function validateToolArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'Arguments must be a JSON object.' };
  const allowed = {
    check_product_info: ['product', 'question'], calculate_pricing: ['product', 'quantity', 'plan'], generate_quote: ['product', 'quantity', 'plan'],
    schedule_followup: ['requested_time', 'channel', 'notes'], update_lead_status: ['status', 'reason'], end_call: ['reason']
  }[name];
  if (!allowed || Object.keys(args).some((key) => !allowed.includes(key))) return { ok: false, error: 'Arguments contain unsupported fields.' };
  const stringField = (key, max, required = false) => typeof args[key] === 'string' && args[key].trim().length > 0 && args[key].length <= max || (!required && args[key] === undefined);
  switch (name) {
    case 'check_product_info':
      return stringField('product', 120, true) && stringField('question', 400, true) ? { ok: true, value: { product: args.product.trim(), question: args.question.trim() } } : { ok: false, error: 'Provide a product name and a question, within the allowed lengths.' };
    case 'calculate_pricing':
    case 'generate_quote':
      return stringField('product', 120, true) && stringField('plan', 80) && (args.quantity === undefined || Number.isInteger(args.quantity) && args.quantity >= 1 && args.quantity <= 10000) ? { ok: true, value: args } : { ok: false, error: 'Product, plan, or quantity is invalid.' };
    case 'schedule_followup':
      return stringField('requested_time', 160, true) && stringField('channel', 20) && stringField('notes', 300) && (!args.channel || ['email', 'phone', 'demo', 'other'].includes(args.channel)) ? { ok: true, value: args } : { ok: false, error: 'Follow-up details are invalid.' };
    case 'update_lead_status':
      return leadStatuses.includes(args.status) && stringField('reason', 300, true) ? { ok: true, value: args } : { ok: false, error: 'Lead status or reason is invalid.' };
    case 'end_call':
      return stringField('reason', 240, true) ? { ok: true, value: args } : { ok: false, error: 'An end-call reason is required.' };
    default:
      return { ok: false, error: 'Unknown tool.' };
  }
}

export function validateToolResult(name, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, error: 'Tool returned a non-object result.' };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192) return { ok: false, error: 'Tool result exceeded the 8 KB limit.' };
  if (name === 'check_product_info' && typeof result.found !== 'boolean') return { ok: false, error: 'Product lookup result is malformed.' };
  if (['calculate_pricing', 'generate_quote'].includes(name) && typeof result.available !== 'boolean') return { ok: false, error: 'Quote result is malformed.' };
  if (name === 'schedule_followup' && typeof result.booked !== 'boolean') return { ok: false, error: 'Follow-up result is malformed.' };
  if (name === 'update_lead_status' && typeof result.updated !== 'boolean') return { ok: false, error: 'Lead update result is malformed.' };
  if (name === 'end_call' && typeof result.end_call !== 'boolean') return { ok: false, error: 'End-call result is malformed.' };
  return { ok: true, value: result };
}
