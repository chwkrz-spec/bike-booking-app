import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const renter = {
  email: 'renter@example.test',
  phone: '+48 500 123 456',
  riderHeight: 176,
  acceptedTerms: true,
};

async function checkoutWithPayment(app, slotIndex = 0) {
  const { body: offer } = await app.request('/api/offer');
  const selection = { ...app.selection(offer), slotId: offer.slots[slotIndex].id };
  const hold = await app.request('/api/checkouts', { method: 'POST', body: selection });
  assert.equal(hold.status, 201);
  const path = '/api/checkouts/' + hold.body.id;
  const payment = await app.request(path + '/payment', { method: 'POST', body: renter });
  assert.equal(payment.status, 200);
  const paymentId = payment.body.paymentUrl.split('/').at(-1);
  const simulatorPath = '/api/simulator/payments/' + paymentId;
  const paid = await app.request(simulatorPath + '/pay', { method: 'POST', body: {} });
  assert.equal(paid.body.status, 'paid');
  return { hold: hold.body, selection, path, paymentId, simulatorPath };
}

function notify(app, paymentId) {
  return app.request('/api/payment-notifications', { method: 'POST', body: { paymentId } });
}

function staffBookings(app) {
  return app.request('/api/staff/bookings', { headers: { Authorization: staffAuthorization } });
}

test('Spóźniona weryfikacja zabezpiecza oryginalną rezerwację tylko raz, także tuż przed odbiorem', async (t) => {
  const app = await startTestApp(t);
  const { hold, path, paymentId } = await checkoutWithPayment(app);
  app.advance(56);
  assert.equal((await app.request(path)).body.status, 'expired');

  const results = await Promise.all([notify(app, paymentId), notify(app, paymentId)]);
  const [first, second] = results;
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'confirmed');
  assert.ok(first.body.bookingId);
  assert.deepEqual(second, first);
  assert.deepEqual(await notify(app, paymentId), first);
  const { body: bookings } = await staffBookings(app);
  assert.equal(bookings.length, 1);
  const { id, shopId, categoryId, pickupAt, returnAt, total } = bookings[0];
  assert.deepEqual({ id, shopId, categoryId, pickupAt, returnAt, total }, {
    id: first.body.bookingId,
    shopId: hold.shopId,
    categoryId: hold.categoryId,
    pickupAt: hold.pickupAt,
    returnAt: hold.returnAt,
    total: 2000,
  });
  assert.equal((await app.request(path + '/confirmation')).body.to, renter.email);
});

test('Zajęty sprzęt skutkuje jednym pełnym zwrotem i informacją, także po ponowieniu weryfikacji', async (t) => {
  const app = await startTestApp(t);
  const { path, selection, paymentId, simulatorPath } = await checkoutWithPayment(app, 1);
  app.advance(15);
  const otherHold = await app.request('/api/checkouts', { method: 'POST', body: selection });
  assert.equal(otherHold.status, 201);

  const [first, second] = await Promise.all([notify(app, paymentId), notify(app, paymentId)]);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'refund_started');
  assert.ok(first.body.refundId);
  assert.deepEqual(second, first);
  app.advance(15);
  const { body: offer } = await app.request('/api/offer');
  assert.ok(offer.slots.some(({ id }) => id === selection.slotId));
  assert.deepEqual(await notify(app, paymentId), first);
  assert.deepEqual((await staffBookings(app)).body, []);
  assert.equal((await app.request(path + '/confirmation')).status, 404);

  const { body: payment } = await app.request(simulatorPath);
  assert.equal(payment.status, 'refund_started');
  assert.deepEqual(payment.refund, { id: first.body.refundId, amount: 2000 });
  const message = await app.request(path + '/payment-failure');
  assert.equal(message.status, 200);
  assert.equal(message.body.to, renter.email);
  assert.match(message.body.content, /nie możemy zrealizować.*pełny zwrot/i);
});

test('Pełny zwrot po rozpoczęciu terminu odbioru, mimo wolnego sprzętu', async (t) => {
  const app = await startTestApp(t);
  const { path, paymentId, simulatorPath } = await checkoutWithPayment(app);
  app.advance(57);

  const result = await notify(app, paymentId);
  assert.equal(result.body.status, 'refund_started');
  assert.deepEqual((await staffBookings(app)).body, []);
  assert.equal((await app.request(simulatorPath)).body.refund.amount, 2000);
  assert.equal((await app.request(path + '/payment-failure')).body.to, renter.email);
});

test('Zwrot rozpoczęty przed weryfikacją wyklucza rezerwację dostępnego sprzętu i drugi zwrot', async (t) => {
  const app = await startTestApp(t, { allowSimulatedRefunds: true });
  const { path, paymentId, simulatorPath } = await checkoutWithPayment(app);
  app.advance(15);
  const priorRefund = await app.request(simulatorPath + '/refund', { method: 'POST', body: {} });
  assert.equal(priorRefund.status, 200);
  assert.equal(priorRefund.body.amount, 2000);

  const result = await notify(app, paymentId);
  assert.deepEqual(result.body, { status: 'refund_started', refundId: priorRefund.body.id });
  assert.deepEqual(await notify(app, paymentId), result);
  assert.deepEqual((await app.request(simulatorPath)).body.refund, priorRefund.body);
  assert.deepEqual((await staffBookings(app)).body, []);
  assert.equal((await app.request(path + '/payment-failure')).body.to, renter.email);
});
