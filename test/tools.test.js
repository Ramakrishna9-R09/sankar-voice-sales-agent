import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments, validateToolResult } from '../agent/tools.js';

test('validates the new order-status and support-ticket adapter inputs', () => {
  assert.equal(validateToolArguments('check_order_status', { order_id: 'ORD-1042' }).ok, true);
  assert.equal(validateToolArguments('check_order_status', { order_id: '  ' }).ok, false);
  assert.equal(validateToolArguments('create_support_ticket', { subject: 'Login trouble', description: 'User cannot access account', priority: 'high' }).ok, true);
  assert.equal(validateToolArguments('create_support_ticket', { subject: 'Help', description: 'Need assistance', priority: 'urgent' }).ok, false);
});

test('rejects malformed or unconfirmed external results', () => {
  assert.equal(validateToolResult('check_order_status', { status: 'shipped' }).ok, false);
  assert.equal(validateToolResult('create_support_ticket', { created: true, ticket_id: 'T-1' }).ok, true);
});
