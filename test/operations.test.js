import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const shop = '/api/staff/shops/warszawa-demo';
const categoryId = 'rower-turystyczny';
const pickup = '2027-01-15T14:00:00.000Z';
const returnAt = '2027-01-15T15:00:00.000Z';
const renter = { email: 'renter@example.test', phone: '+48 500 123 456', riderHeight: 176, acceptedTerms: true };
const owner = { Authorization: staffAuthorization };
const staffGet = (app, path, headers = owner) => app.request(path, { headers });
const post = (app, path, body = {}, headers) => app.request(path, { method: 'POST', body, headers });
const selection = { shopId: 'warszawa-demo', categoryId, slotId: pickup, returnAt };

async function payment(app, selection) {
  const hold = await post(app, '/api/checkouts', selection);
  assert.equal(hold.status, 201);
  const started = await post(app, '/api/checkouts/' + hold.body.id + '/payment', renter);
  assert.equal(started.status, 200);
  const paymentId = started.body.paymentUrl.split('/').at(-1);
  return { id: hold.body.id, paymentId };
}
async function confirm(app, pending) {
  const { id, paymentId } = pending;
  assert.equal((await post(app, '/api/simulator/payments/' + paymentId + '/pay')).body.status, 'paid');
  const result = await post(app, '/api/payment-notifications', { paymentId });
  return { ...result.body, checkout: id };
}
async function book(app, selection) {
  const result = await confirm(app, await payment(app, selection));
  assert.equal(result.status, 'confirmed');
  return result;
}
const bookingPath = (id) => shop + '/bookings/' + id;

test('Obsługa oznacza No-Show po zaakceptowanym czasie oczekiwania i zwalnia sprzęt bez zwrotu', async (t) => {
  const app = await startTestApp(t);
  const policy = '/api/staff/cancellation-policy';
  assert.equal((await post(app, policy, { noShowGraceMinutes: 10 }, owner)).status, 200);
  const booked = await book(app, { ...selection, returnAt: '2027-01-15T16:00:00.000Z' });
  assert.equal((await post(app, policy, { noShowGraceMinutes: 45 }, owner)).status, 200);

  const member = 'operators';
  const password = 'operations-spec-password';
  const staff = { Authorization: 'Basic ' + Buffer.from(member + ':' + password).toString('base64') };
  assert.equal((await post(app, '/api/staff/members', { username: member, password }, owner)).status, 201);
  const noShow = bookingPath(booked.bookingId) + '/no-show';
  assert.equal((await post(app, noShow, {}, staff)).status, 404);
  assert.equal((await post(app, '/api/staff/members/' + member + '/assignments', {
    shopId: selection.shopId, canRefund: false,
  }, owner)).status, 200);

  app.advance(66);
  assert.equal((await post(app, noShow, {}, staff)).status, 409);
  app.advance(1);
  const resold = { ...selection, slotId: '2027-01-15T15:00:00.000Z', returnAt: '2027-01-15T15:30:00.000Z' };
  assert.equal((await post(app, '/api/checkouts', resold)).status, 409);
  assert.equal((await post(app, noShow, {}, staff)).body.status, 'no_show');
  assert.equal((await post(app, noShow, {}, staff)).body.cancellationRefund, 0);
  const { body: history } = await staffGet(app, '/api/staff/bookings/' + booked.bookingId + '/refunds');
  assert.deepEqual(history, []);
  const { body: message } = await app.request('/api/checkouts/' + booked.checkout + '/confirmation');
  const { body: view } = await app.request('/api' + message.bookingUrl.replace('/booking/', '/bookings/'));
  assert.equal(view.status, 'no_show');
  assert.equal(view.canCancel, false);
  assert.equal((await post(app, '/api/checkouts', resold)).status, 201);
});

test('Wydany sprzęt pozostaje zajęty po terminie, zagrożona rezerwacja jest widoczna do zwrotu', async (t) => {
  const app = await startTestApp(t);
  const issued = await book(app, selection);
  const future = { ...selection, slotId: '2027-01-15T16:00:00.000Z', returnAt: '2027-01-15T16:30:00.000Z' };
  const later = await book(app, future);
  const cannotFulfill = await book(app, {
    ...selection, slotId: '2027-01-16T10:00:00.000Z', returnAt: '2027-01-16T10:30:00.000Z',
  });
  app.advance(57);
  const assign = { items: [{ itemId: categoryId, units: ['TOUR-1'] }] };
  assert.equal((await post(app, bookingPath(issued.bookingId) + '/pickup', assign, owner)).status, 200);
  app.advance(30);
  const unsold = { ...selection, slotId: '2027-01-15T16:30:00.000Z', returnAt: '2027-01-15T17:00:00.000Z' };
  const pending = await payment(app, unsold);
  assert.equal((await post(app, '/api/simulator/payments/' + pending.paymentId + '/pay')).body.status, 'paid');
  app.advance(30);

  const bookings = async () => (await staffGet(app, shop + '/bookings')).body;
  const [overdue, affected] = await bookings();
  assert.equal(overdue.id, issued.bookingId);
  assert.equal(overdue.overdue, true);
  assert.equal(affected.id, later.bookingId);
  assert.deepEqual(affected.atRiskItems.map(({ itemId }) => itemId), [categoryId]);
  assert.equal((await bookings())[2].atRiskItems[0].itemId, categoryId);
  const cancelled = await post(app, '/api/staff/bookings/' + cannotFulfill.bookingId + '/cancel', {}, owner);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.cancellationRefund, 2000);
  assert.equal((await post(app, bookingPath(issued.bookingId) + '/no-show', {}, owner)).status, 409);
  assert.equal((await post(app, '/api/staff/bookings/' + issued.bookingId + '/cancel', {}, owner)).status, 409);
  assert.equal((await post(app, '/api/checkouts', unsold)).status, 409);
  const late = await post(app, '/api/payment-notifications', { paymentId: pending.paymentId });
  assert.equal(late.body.status, 'refund_started');

  const returnPath = bookingPath(issued.bookingId) + '/return';
  assert.equal((await post(app, bookingPath(later.bookingId) + '/return', {}, owner)).status, 409);
  const otherShop = await post(app, '/api/staff/shops', { name: 'Inny punkt' }, owner);
  assert.equal((await post(app, returnPath.replace(selection.shopId, otherShop.body.id), {}, owner)).status, 404);
  const returned = await post(app, returnPath, {}, owner);
  assert.equal(returned.status, 200);
  assert.equal(returned.body.returnedAt, returnAt);
  assert.deepEqual(await post(app, returnPath, {}, owner), returned);
  const [completed, safe] = await bookings();
  assert.equal(completed.overdue, false);
  assert.equal(completed.equipmentReturn.returnedAt, returnAt);
  assert.deepEqual(safe.atRiskItems, []);
  assert.equal((await post(app, '/api/checkouts', unsold)).status, 201);
  assert.deepEqual(await post(app, '/api/payment-notifications', { paymentId: pending.paymentId }), late);
});

test('Awaria blokuje sprzedaż i wskazuje pojazd zastępczy bez zmiany ceny rezerwacji', async (t) => {
  const app = await startTestApp(t);
  const booked = await book(app, selection);
  const nextSlot = { ...selection, slotId: returnAt, returnAt: '2027-01-15T15:30:00.000Z' };
  const activePayment = await payment(app, nextSlot);
  const replacement = 'rower-dzieciecy';
  assert.equal((await post(app, shop + '/stock', { itemId: categoryId, quantity: 0 }, owner)).status, 200);
  const staffBooking = async () => (await staffGet(app, shop + '/bookings')).body[0];
  const affected = await staffBooking();
  assert.deepEqual(affected.atRiskItems.map(({ itemId, shortBy }) => ({ itemId, shortBy })), [{ itemId: categoryId, shortBy: 1 }]);
  const { body: offer } = await app.request('/api/offer?pickupAt=' + encodeURIComponent(pickup));
  assert.equal(offer.slots[0].availableQuantities[categoryId], 0);
  assert.equal((await post(app, '/api/checkouts', selection)).status, 409);

  const result = await confirm(app, activePayment);
  assert.equal(result.status, 'refund_started');
  assert.equal((await post(app, '/api/payment-notifications', { paymentId: activePayment.paymentId })).body.refundId, result.refundId);

  const substitute = bookingPath(booked.bookingId) + '/substitute';
  assert.equal((await post(app, substitute, {
    fromItemId: categoryId, toItemId: 'kask', quantity: 1, revision: 0,
  }, owner)).status, 400);
  const agreement = { fromItemId: categoryId, toItemId: replacement, quantity: 1, revision: 0 };
  assert.equal((await post(app, substitute, agreement, owner)).status, 200);
  assert.equal((await post(app, substitute, agreement, owner)).status, 409);
  const updated = await staffBooking();
  assert.deepEqual(updated.atRiskItems, []);
  assert.equal(updated.items[0].itemId, categoryId);
  assert.equal(updated.allocatedItems[0].itemId, replacement);
  assert.equal(updated.total, 2000);
  assert.equal((await post(app, '/api/checkouts', {
    ...selection, items: [{ itemId: replacement, quantity: 2 }],
  })).status, 409);

  app.advance(57);
  const assign = { items: [{ itemId: replacement, units: ['KID-1'] }] };
  assert.equal((await post(app, bookingPath(booked.bookingId) + '/pickup', assign, owner)).status, 200);
});
