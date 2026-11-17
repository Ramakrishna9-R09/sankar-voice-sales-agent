import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpokenSentence } from '../agent/guardrails.js';

test('blocks unsupported commercial terms and invented product features', () => {
  assert.equal(validateSpokenSentence('We include a 99.99% uptime guarantee.').ok, false);
  assert.equal(validateSpokenSentence('The product integrates with QuickBooks.', { knowledge: [] }).ok, false);
});

test('allows a feature claim only when enough matching trusted evidence is present', () => {
  const knowledge = [{ text: 'Integrates with QuickBooks and includes automated invoice reminders.' }];
  assert.equal(validateSpokenSentence('It integrates with QuickBooks and includes automated invoice reminders.', { knowledge }).ok, true);
});

test('allows a quoted price only when a validated pricing tool supplied the amount and currency', () => {
  const toolActions = [{ name: 'generate_quote', total: 29, unit_price: 29, quantity: 1, currency: 'USD', billing_period: 'per seat per month' }];
  assert.equal(validateSpokenSentence('The price is USD 29 per seat per month.', { toolActions }).ok, true);
  assert.equal(validateSpokenSentence('I can offer a 20% discount.', { toolActions }).ok, false);
  assert.equal(validateSpokenSentence('The price is USD 99 per seat per month.', { toolActions }).ok, false);
  assert.equal(validateSpokenSentence('The price is USD 1 per seat per month.', { toolActions: [{ ...toolActions[0], total: 29, unit_price: 29, quantity: 1 }] }).ok, false);
  assert.equal(validateSpokenSentence('It costs 1 per seat each month.', { toolActions: [{ ...toolActions[0], total: 29, unit_price: 29, quantity: 1 }] }).ok, false);
});
