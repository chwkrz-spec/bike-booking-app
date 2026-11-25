import assert from 'node:assert/strict';
import test from 'node:test';
import { createP24Sandbox } from '../tools/p24-sandbox.js';

const credentials = { merchantId: 91, posId: 92, apiKey: 'test-key', crc: 'test-crc' };
const payment = { sessionId: 'test/rower-ą', amount: 100000 };
const notification = {
  merchantId: 91,
  posId: 92,
  ...payment,
  originAmount: 100000,
  currency: 'PLN',
  orderId: 4001,
  methodId: 1,
  statement: 'test/ą',
  sign: '0e6a43bf2ec0d93c5cca6958ce3a9830f09ef7546d272f23ff4811643b5f21e373dd554d15c2c1cd9233a4ac10e7dd7d',
};

test('verifies an authentic notification for the registered full prepayment', async () => {
  const sandbox = createP24Sandbox(credentials, async (url, options) => {
    assert.equal(String(url), 'https://sandbox.przelewy24.pl/api/v1/transaction/verify');
    assert.equal(options.method, 'PUT');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Basic OTI6dGVzdC1rZXk=');
    assert.deepEqual(JSON.parse(options.body), {
      merchantId: 91,
      posId: 92,
      ...payment,
      orderId: 4001,
      currency: 'PLN',
      sign: 'ced55f9f980d83800627d69afa43d7ba1964a632ff97a0ed74688a4011c3d7296fe552e4e68635d6196c0367fc4db2ac',
    });
    return Response.json({ data: { status: 'success' }, responseCode: 0 });
  });

  assert.equal(await sandbox.verify(payment, notification), 4001);
});

test('rejects a modified notification before calling the provider', async () => {
  const sandbox = createP24Sandbox(credentials, () => assert.fail('Provider must not be called'));

  await assert.rejects(sandbox.verify(payment, { ...notification, amount: 50000 }), /registered sandbox payment/);
  await assert.rejects(sandbox.verify(payment, { ...notification, orderId: 4002 }), /signature/);
});

test('registers a PLN payment with the requested limit and returns a sandbox checkout URL', async () => {
  const urls = { urlReturn: 'https://example.test/return', urlStatus: 'https://example.test/status' };
  const sandbox = createP24Sandbox(credentials, async (url, options) => {
    assert.equal(String(url), 'https://sandbox.przelewy24.pl/api/v1/transaction/register');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      merchantId: 91,
      posId: 92,
      ...payment,
      currency: 'PLN',
      description: 'Sandbox bike rental',
      email: 'sandbox@example.test',
      country: 'PL',
      language: 'pl',
      ...urls,
      timeLimit: 15,
      sign: 'f37b2b3d1af866066bfd55660189214b94626b9a3d5090997aaeebc795fa919d319d822d76194cba0d32bd72877c6cd6',
    });
    return Response.json({ data: { token: 'AB12-CD' }, responseCode: 0 });
  });

  assert.equal(await sandbox.register({ ...payment, ...urls, timeLimit: 15 }),
    'https://sandbox.przelewy24.pl/trnRequest/AB12-CD');
});

test('dispatches the operator-specified amount to a sandbox submerchant', async () => {
  const details = { orderId: 4001, sessionId: payment.sessionId, sellerId: 93, amount: 95000 };
  const sandbox = createP24Sandbox({ ...credentials, marketplaceApiKey: 'market-test-key' }, async (url, options) => {
    assert.equal(String(url), 'https://sandbox.przelewy24.pl/api/v1/multiStore/dispatchTransaction');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Basic OTE6bWFya2V0LXRlc3Qta2V5');
    assert.deepEqual(JSON.parse(options.body), { batchId: 1001, details: [details] });
    return Response.json({ result: [{ ...details, orderIdNew: 4002, status: true, error: '' }] });
  });

  assert.equal(await sandbox.dispatch({ batchId: 1001, ...details }), 4002);
});

test('submits the explicit refund debits and checks that P24 accepted them', async () => {
  const data = [{ spId: 93, spAmount: 47500 }, { spId: 91, spAmount: 2500 }];
  const refund = { orderId: 4001, sessionId: payment.sessionId, amount: 50000, data };
  const sandbox = createP24Sandbox({ ...credentials, marketplaceApiKey: 'market-test-key' }, async (url, options) => {
    assert.equal(String(url), 'https://sandbox.przelewy24.pl/api/v1/multiStore/refund');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      requestId: 'refund-1', refundsUuid: 'merchant-refund-1', refunds: [refund],
    });
    return Response.json({ data: [{ ...refund, status: true }], responseCode: '0' }, { status: 201 });
  });

  await sandbox.refund({ requestId: 'refund-1', refundsUuid: 'merchant-refund-1', ...refund });
  await assert.rejects(
    sandbox.refund({ requestId: 'refund-2', refundsUuid: 'merchant-refund-2', ...refund, amount: 100000 }),
    /debits must add up/,
  );
});
