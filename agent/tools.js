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

export async function executeTool(name, args = {}) {
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
      // Capture intent honestly until a real calendar integration is configured.
      return { captured: true, requested_time: String(args.requested_time || '').slice(0, 160), channel: args.channel || 'other', notes: String(args.notes || '').slice(0, 300), booked: false, message: 'The prospect requested this follow-up time. No calendar is connected, so it is not booked. Confirm the follow-up manually and do not say it has been scheduled.' };
    case 'update_lead_status':
      return leadStatuses.includes(args.status)
        ? { updated: true, status: args.status, reason: String(args.reason || '').slice(0, 300) }
        : { updated: false, message: 'Status was not changed because it is outside the supported set.' };
    case 'end_call':
      return { end_call: true, reason: String(args.reason || '').slice(0, 240) };
    default:
      return { error: `Unsupported tool: ${name}` };
  }
}

export { leadStatuses };

