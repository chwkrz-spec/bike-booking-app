import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { p24SandboxFromEnv } from '../tools/p24-sandbox.js';

const fixturePath = process.env.P24_SANDBOX_FIXTURE;
if (!fixturePath) throw new Error('Set P24_SANDBOX_FIXTURE to an evidence file from the P24 Marketplace sandbox');

const sandbox = p24SandboxFromEnv();
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
const { prepayment, repeatedNotification, latePayment, replacedLinkRefund, partialRefund, settlement } = fixtures;

const sessionIds = [
  prepayment, repeatedNotification, latePayment, replacedLinkRefund, partialRefund, settlement,
].map(fixture => fixture?.sessionId);
assert(sessionIds.every(id => typeof id === 'string' && id.length), 'Provide a sandbox session ID for every fixture');
assert.equal(new Set(sessionIds).size, sessionIds.length, 'Use a separate sandbox transaction for each scenario');

function receivedAt(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'Use UTC timestamps');
  const timestamp = Date.parse(value);
  assert(Number.isFinite(timestamp), 'Use a valid timestamp');
  return timestamp;
}

async function verifyPrepayment(fixture, notification) {
  const orderId = await sandbox.verify(fixture, notification);
  const details = await sandbox.transaction(fixture.sessionId);
  assert.equal(details.orderId, orderId);
  assert.equal(details.sessionId, fixture.sessionId);
  assert.equal(details.amount, fixture.amount);
  assert.equal(details.currency, 'PLN');
  assert.equal(details.status, 2, 'P24 must report payment made after verification');
}

async function assertCompletedRefund(fixture, amount) {
  const details = await sandbox.refunds(fixture.orderId);
  assert.equal(details.orderId, fixture.orderId);
  assert.equal(details.sessionId, fixture.sessionId);
  assert.equal(details.amount, 100000);
  assert.equal(details.currency, 'PLN');
  assert.equal(details.refunds.length, 1, 'Dedicated sandbox fixture must have exactly one refund');
  const [refund] = details.refunds;
  assert.equal(refund.requestId, fixture.requestId);
  assert.equal(refund.amount, amount);
  assert.equal(refund.status, 1, 'P24 must report a completed refund');
}

test('P24 verifies the signed notification for the full prepayment', async () => {
  await verifyPrepayment(prepayment, prepayment.notification);
});

test('P24 sends the same signed transaction result on redelivery before verification', async () => {
  const { first, retry } = repeatedNotification;
  assert(receivedAt(retry.receivedAt) > receivedAt(first.receivedAt), 'Capture two actual deliveries');
  assert.deepEqual(retry.notification, first.notification);
  await verifyPrepayment(repeatedNotification, retry.notification);
});

test('P24 verifies a paid notification received after the local Checkout Hold deadline', async () => {
  assert(receivedAt(latePayment.receivedAt) > receivedAt(latePayment.checkoutExpiresAt));
  await verifyPrepayment(latePayment, latePayment.notification);
});

test('P24 reports one completed full refund of the payment for the replaced link', async () => {
  await assertCompletedRefund(replacedLinkRefund, 100000);
});

test('P24 reports one completed partial refund for the expected amount', async () => {
  await assertCompletedRefund(partialRefund, 50000);
});

test('P24 reports the intended Partner dispatch on a verified 1,000 PLN prepayment', async (t) => {
  const payment = await sandbox.transaction(settlement.sessionId);
  assert.equal(payment.sessionId, settlement.sessionId);
  assert.equal(payment.orderId, settlement.orderId);
  assert.equal(payment.amount, 100000);
  assert.equal(payment.currency, 'PLN');
  assert.equal(payment.status, 2);

  const details = await sandbox.dispatchInfo(settlement.orderId);
  const dispatches = details.dispatch.filter(row => row.partner_id === settlement.sellerId);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].amount, 95000);
  assert(Number.isSafeInteger(details.amountLeft), 'Record the provider-reported remainder');
  t.diagnostic(`P24-reported amountLeft: ${details.amountLeft} grosz`);
});
