import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const owner = { Authorization: staffAuthorization };
const policyPath = '/api/staff/cancellation-policy';
const renter = {
  email: 'renter@example.test',
  phone: '+48 500 123 456',
  riderHeight: 176,
  acceptedTerms: true,
};

const post = (app, path, body = {}, headers) => app.request(path, { method: 'POST', body, headers });

async function holdRental(app, extra = {}) {
  const { body: offer } = await app.request('/api/offer');
  const selection = { ...app.selection(offer), ...extra };
  const held = await post(app, '/api/checkouts', selection);
  assert.equal(held.status, 201);
  return { selection, held: held.body, path: '/api/checkouts/' + held.body.id };
}

async function payRental(app, checkout, details = renter) {
  const payment = await post(app, checkout.path + '/payment', details);
  assert.equal(payment.status, 200);
  const paymentId = payment.body.paymentUrl.split('/').at(-1);
  assert.equal((await post(app, '/api/simulator/payments/' + paymentId + '/pay')).body.status, 'paid');
  const confirmed = await post(app, '/api/payment-notifications', { paymentId });
  assert.equal(confirmed.body.status, 'confirmed');
  const { body: message } = await app.request(checkout.path + '/confirmation');
  assert.match(message.bookingUrl, /^\/booking\/[\w-]+$/);
  assert.ok(message.content.includes(message.bookingUrl));
  return { ...confirmed.body, paymentId, manage: '/api' + message.bookingUrl.replace('/booking/', '/bookings/') };
}

test('Dokładnie na granicy 24 godzin prywatny link zwraca 500 PLN z podziałem 475/25 tylko raz', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T12:00:00.000Z' });
  const { body: offer } = await app.request('/api/offer');
  assert.equal((await post(app, '/api/staff/shops/' + offer.shop.id + '/settings', {
    maxRentalMinutes: 3000,
    weeklyHours: Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, [['00:00', '24:00']]]),
    ),
  }, owner)).status, 200);
  const checkout = await holdRental(app, {
    slotId: '2027-01-16T12:00:00.000Z',
    returnAt: '2027-01-18T14:00:00.000Z',
  });
  assert.equal(checkout.held.total, 100_000);
  const { manage, bookingId, paymentId } = await payRental(app, checkout);
  const view = await app.request(manage);
  assert.equal(view.body.freeCancellationCutoff, '2027-01-15T12:00:00.000Z');
  assert.equal(view.body.cancellationRefund, 50_000);
  assert.equal((await app.request('/api/bookings/' + bookingId)).status, 404);
  assert.equal((await app.request('/api/bookings/' + checkout.held.id)).status, 404);
  assert.equal((await app.request('/api/bookings/' + paymentId)).status, 404);

  const first = await post(app, manage + '/cancel');
  const retry = await post(app, manage + '/cancel');
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'cancelled');
  assert.deepEqual(retry, first);
  const history = await app.request('/api/staff/bookings/' + bookingId + '/refunds', { headers: owner });
  assert.equal(history.body.length, 1);
  const { amount, originalAmount, originalCommission, partnerDebit, platformDebit, paymentId: originalPaymentId } = history.body[0];
  assert.deepEqual({ amount, originalAmount, originalCommission, partnerDebit, platformDebit, originalPaymentId }, {
    amount: 50_000, originalAmount: 100_000, originalCommission: 5_000,
    partnerDebit: 47_500, platformDebit: 2_500, originalPaymentId: paymentId,
  });
  assert.equal((await post(app, '/api/checkouts', checkout.selection)).status, 201);
});

test('Zmiana polityki w każdym punkcie dotyczy przyszłych akceptacji i zachowuje podpisane warunki', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T11:59:59.999Z' });
  const pickup = '2027-01-16T12:00:00.000Z';
  const existing = await holdRental(app, { slotId: pickup });
  const confirmed = await payRental(app, existing, { ...renter, termsVersion: existing.held.termsVersion });
  const otherShop = await post(app, '/api/staff/shops', { name: 'Drugi punkt' }, owner);
  assert.equal(otherShop.status, 201);
  const awaitingAcceptance = await holdRental(app, { shopId: otherShop.body.id, slotId: pickup });
  const nextPolicy = { freeCancellationMinutes: 720, lateRefundPercent: 25, noShowGraceMinutes: 45 };
  assert.equal((await post(app, policyPath, nextPolicy, owner)).status, 200);
  assert.deepEqual((await app.request(policyPath, { headers: owner })).body, nextPolicy);

  const view = await app.request(confirmed.manage);
  assert.equal(view.body.terms, existing.held.terms);
  assert.equal(view.body.termsAcceptedAt, '2027-01-15T11:59:59.999Z');
  assert.equal(view.body.freeCancellationCutoff, '2027-01-15T12:00:00.000Z');
  assert.equal(view.body.cancellationRefund, 2000);

  const outdated = await post(app, awaitingAcceptance.path + '/payment', {
    ...renter, termsVersion: awaitingAcceptance.held.termsVersion,
  });
  assert.equal(outdated.status, 409);
  const { body: updated } = await app.request(awaitingAcceptance.path);
  assert.notEqual(updated.terms, awaitingAcceptance.held.terms);
  assert.match(updated.terms, /25%/);
  const newBooking = await payRental(app, awaitingAcceptance, { ...renter, termsVersion: updated.termsVersion });
  assert.equal((await app.request(newBooking.manage)).body.freeCancellationCutoff, '2027-01-16T00:00:00.000Z');

  app.advance(2 / 60_000);
  const outdatedRefund = await post(app, confirmed.manage + '/cancel', { expectedRefund: view.body.cancellationRefund });
  assert.equal(outdatedRefund.status, 409);
  assert.equal((await app.request(confirmed.manage)).body.status, 'confirmed');
  const result = await post(app, confirmed.manage + '/cancel');
  assert.equal(result.body.cancellationRefund, 1000);
  assert.equal((await app.request(newBooking.manage)).body.cancellationRefund, 2000);
});

test('Tylko pracownik z uprawnieniem do zwrotów w tym punkcie może anulować z pełnym zwrotem', async (t) => {
  const app = await startTestApp(t, {
    demoOwners: [{ username: 'foreign-owner', password: 'separate-credentials', partnerId: 'separate-partner' }],
  });
  const auth = (username, password) => ({
    Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
  });
  const checkout = await holdRental(app);
  const confirmed = await payRental(app, checkout);
  const create = await post(app, '/api/staff/members', { username: 'operator', password: 'test-member-password' }, owner);
  assert.equal(create.status, 201);
  const staff = auth('operator', 'test-member-password');
  const foreign = auth('foreign-owner', 'separate-credentials');
  const assignment = '/api/staff/members/operator/assignments';
  const { shopId } = checkout.held;
  const staffBooking = '/api/staff/bookings/' + confirmed.bookingId;
  assert.equal((await post(app, staffBooking + '/cancel', {}, foreign)).status, 404);
  assert.equal((await post(app, staffBooking + '/cancel', {}, staff)).status, 404);
  assert.equal((await post(app, assignment, { shopId, canRefund: false }, owner)).status, 200);
  assert.equal((await post(app, staffBooking + '/cancel', {}, staff)).status, 403);
  assert.equal((await app.request(policyPath, { headers: staff })).status, 403);

  assert.equal((await post(app, assignment, { shopId, canRefund: true }, owner)).status, 200);
  const [result, retry] = await Promise.all([
    post(app, staffBooking + '/cancel', {}, staff),
    post(app, staffBooking + '/cancel', {}, staff),
  ]);
  assert.equal(result.status, 200);
  assert.equal(result.body.cancellationRefund, 2000);
  assert.equal(result.body.cancellationSource, 'partner');
  assert.deepEqual(retry, result);
  assert.deepEqual(await app.request(confirmed.manage), result);
  const { body: history } = await app.request(staffBooking + '/refunds', { headers: owner });
  assert.equal(history.length, 1);
  assert.equal(history[0].approvedBy, 'operator');
  assert.equal(history[0].amount, 2000);
  const notification = await post(app, '/api/payment-notifications', { paymentId: confirmed.paymentId });
  assert.equal(notification.body.status, 'cancelled');
  assert.equal((await post(app, '/api/checkouts', checkout.selection)).status, 201);
});
