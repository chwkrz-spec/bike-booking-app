import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const dashboard = '/api/staff/owner-dashboard';
const owner = { Authorization: staffAuthorization };
const authentication = (username, password) => ({
  Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
});
const post = (app, path, body = {}, headers) => app.request(path, { method: 'POST', body, headers });

test('Dashboard jest dostępny wyłącznie dla właściciela i tylko dla punktów jego Partnera', async (t) => {
  const foreign = authentication('another-owner', 'another-owner-password');
  const staff = authentication('operator', 'operator-demo-password');
  const app = await startTestApp(t, {
    demoOwners: [{ username: 'another-owner', password: 'another-owner-password', partnerId: 'another-partner' }],
  });
  assert.equal((await post(app, '/api/staff/members', {
    username: 'operator', password: 'operator-demo-password',
  }, owner)).status, 201);
  assert.equal((await post(app, '/api/staff/members/operator/assignments', {
    shopId: 'warszawa-demo', canRefund: true,
  }, owner)).status, 200);
  const created = await post(app, '/api/staff/shops', { name: 'Inny Partner' }, foreign);
  assert.equal(created.status, 201);

  assert.equal((await app.request(dashboard)).status, 401);
  assert.equal((await app.request(dashboard, { headers: staff })).status, 403);
  assert.equal((await app.request(dashboard + '?shopId=' + created.body.id, { headers: owner })).status, 404);
  assert.deepEqual((await app.request(dashboard, { headers: owner })).body.shops.map(({ id }) => id), ['warszawa-demo']);
  assert.deepEqual((await app.request(dashboard, { headers: foreign })).body.shops.map(({ id }) => id), [created.body.id]);
});

async function booking(app, { shopId = 'warszawa-demo', slotId, returnAt, channel = 'widget', headers = owner, items }) {
  const selection = { shopId, categoryId: 'rower-turystyczny', slotId, returnAt, items };
  const renter = { email: 'renter@example.test', phone: '+48 500 123 456', riderHeights: [176], acceptedTerms: true };
  const held = channel === 'staff'
    ? await post(app, '/api/staff/shops/' + shopId + '/payment-links', { ...selection, email: renter.email }, headers)
    : await post(app, '/api/checkouts', selection);
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const checkout = held.body.checkout ?? held.body;
  const started = await post(app, '/api/checkouts/' + checkout.id + '/payment', renter);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const paymentId = started.body.paymentUrl.split('/').at(-1);
  assert.equal((await post(app, '/api/simulator/payments/' + paymentId + '/pay')).body.status, 'paid');
  const confirmed = await post(app, '/api/payment-notifications', { paymentId });
  assert.equal(confirmed.body.status, 'confirmed', JSON.stringify(confirmed.body));
  return { checkoutId: checkout.id, id: confirmed.body.bookingId };
}

const at = (day, time) => '2027-01-' + day + 'T' + time + ':00.000Z';

test('Statusy obu kanałów i harmonogram odzwierciedlają daty operacji, punkt i No-Show', async (t) => {
  const foreign = authentication('another-owner', 'another-owner-password');
  const app = await startTestApp(t, {
    demoOwners: [{ username: 'another-owner', password: 'another-owner-password', partnerId: 'another-partner' }],
  });
  const additional = await post(app, '/api/staff/shops', { name: 'Drugi punkt' }, owner);
  const otherPartner = await post(app, '/api/staff/shops', { name: 'Obcy punkt' }, foreign);
  const missed = await booking(app, { slotId: at(15, '14:00'), returnAt: at(15, '15:00') });
  const assigned = await booking(app, { slotId: at(15, '15:00'), returnAt: at(15, '16:00') });
  const rental = await booking(app, {
    channel: 'staff', shopId: additional.body.id, slotId: at(15, '16:00'), returnAt: at(16, '10:00'),
  });
  await booking(app, {
    shopId: otherPartner.body.id, headers: foreign, slotId: at(15, '16:00'), returnAt: at(15, '17:00'),
  });
  app.advance(117);
  const missedPath = '/api/staff/shops/warszawa-demo/bookings/' + missed.id + '/no-show';
  assert.equal((await post(app, missedPath, {}, owner)).body.status, 'no_show');
  const assignedPath = '/api/staff/shops/warszawa-demo/bookings/' + assigned.id;
  assert.equal((await post(app, assignedPath + '/pickup', {
    items: [{ itemId: 'rower-turystyczny', units: ['TOUR-1'] }],
  }, owner)).status, 200);

  const read = async (query = '') => {
    const result = await app.request(dashboard + query, { headers: owner });
    assert.equal(result.status, 200);
    return result.body;
  };
  const all = await read();
  assert.deepEqual(all.counts, {
    confirmed: { widget: 1, staff: 1 }, cancelled: { widget: 0, staff: 0 }, no_show: { widget: 1, staff: 0 },
  });
  assert.deepEqual(all.pickups.map(({ bookingId }) => bookingId), [rental.id]);
  assert.deepEqual(all.returns.map(({ bookingId }) => bookingId), [assigned.id, rental.id]);
  const day = await read('?from=2027-01-16&to=2027-01-16');
  assert.deepEqual(day.counts.confirmed, { widget: 0, staff: 0 });
  assert.deepEqual(day.pickups, []);
  assert.deepEqual(day.returns.map(({ bookingId }) => bookingId), [rental.id]);
  const shop = await read('?shopId=' + additional.body.id + '&to=2027-01-15');
  assert.deepEqual(shop.counts.confirmed, { widget: 0, staff: 1 });
  assert.deepEqual(shop.pickups.map(({ bookingId }) => bookingId), [rental.id]);
  assert.deepEqual(shop.returns, []);
  assert.equal((await post(app, assignedPath + '/return', {}, owner)).status, 200);
  const demoTotals = await read('?shopId=warszawa-demo');
  assert.deepEqual(demoTotals.finances, { collected: 4000, refunded: 0, currency: 'PLN' });
  assert.deepEqual((await read()).returns.map(({ bookingId }) => bookingId), [rental.id]);
  for (const invalid of ['?from=2027-02-29', '?to=15-01-2027', '?from=2027-01-17&to=2027-01-16']) {
    assert.equal((await app.request(dashboard + invalid, { headers: owner })).status, 400);
  }
});

test('Przedpłaty i pełne oraz częściowe zwroty mają własne daty w czasie polskim', async (t) => {
  const foreign = authentication('another-owner', 'another-owner-password');
  const app = await startTestApp(t, {
    date: at(15, '23:03'),
    demoOwners: [{ username: 'another-owner', password: 'another-owner-password', partnerId: 'another-partner' }],
  });
  const other = await post(app, '/api/staff/shops', { name: 'Drugi punkt' }, owner);
  const outside = await post(app, '/api/staff/shops', { name: 'Obcy punkt' }, foreign);
  const full = await booking(app, { slotId: at(17, '12:00'), returnAt: at(17, '13:00') });
  const partial = await booking(app, {
    channel: 'staff', shopId: other.body.id, slotId: at(17, '12:00'), returnAt: at(17, '14:00'),
  });
  const foreignRental = await booking(app, {
    shopId: outside.body.id, headers: foreign, slotId: at(17, '12:00'), returnAt: at(17, '17:00'),
  });
  app.advance(24 * 60);
  for (const [id, headers] of [[full.id, owner], [foreignRental.id, foreign]]) {
    assert.equal((await post(app, '/api/staff/bookings/' + id + '/cancel', {}, headers)).status, 200);
  }
  const { body: message } = await app.request('/api/checkouts/' + partial.checkoutId + '/confirmation');
  const privatePath = '/api' + message.bookingUrl.replace('/booking/', '/bookings/');
  assert.equal((await post(app, privatePath + '/cancel', { expectedRefund: 2000 })).status, 200);

  const finances = async (query = '') => (await app.request(dashboard + query, { headers: owner })).body.finances;
  assert.deepEqual(await finances(), { collected: 6000, refunded: 4000, currency: 'PLN' });
  assert.deepEqual(await finances('?to=2027-01-15'), { collected: 0, refunded: 0, currency: 'PLN' });
  assert.deepEqual(await finances('?from=2027-01-16&to=2027-01-16'), { collected: 6000, refunded: 0, currency: 'PLN' });
  assert.deepEqual(await finances('?from=2027-01-17'), { collected: 0, refunded: 4000, currency: 'PLN' });
  assert.deepEqual(await finances('?shopId=' + other.body.id), { collected: 4000, refunded: 2000, currency: 'PLN' });
  const { body: all } = await app.request(dashboard, { headers: owner });
  assert.deepEqual(all.counts.cancelled, { widget: 1, staff: 1 });
  assert.deepEqual(all.pickups, []);
  assert.deepEqual(all.returns, []);
});

test('Zatwierdzony zwrot za zdjęty sprzęt trafia do wyniku w dacie potwierdzenia operatora', async (t) => {
  const app = await startTestApp(t, { allowSimulatedRefunds: true });
  const rental = await booking(app, {
    slotId: at(15, '14:00'), returnAt: at(15, '15:00'),
    items: [{ itemId: 'rower-turystyczny', quantity: 1 }, { itemId: 'kask', quantity: 1 }],
  });
  app.advance(57);
  const amendment = '/api/staff/shops/warszawa-demo/bookings/' + rental.id + '/amendment';
  const removedItems = [{ itemId: 'kask', quantity: 1 }];
  const preview = await post(app, amendment + '/preview', { removedItems }, owner);
  assert.equal(preview.status, 200);
  const approved = await post(app, amendment, {
    removedItems, charges: preview.body.eligibleCharges.map(({ id, quantity }) => ({ id, quantity })),
    revision: preview.body.revision, expectedRefund: 500, renterAgreed: true,
  }, owner);
  assert.equal(approved.body.refund.status, 'pending');
  const finances = async (query = '') => (await app.request(dashboard + query, { headers: owner })).body.finances;
  assert.deepEqual(await finances(), { collected: 2500, refunded: 0, currency: 'PLN' });

  app.advance(24 * 60);
  const simulated = '/api/simulator/refunds/' + approved.body.refund.id;
  assert.equal((await post(app, simulated, { status: 'completed' })).body.status, 'completed');
  assert.deepEqual(await finances('?to=2027-01-15'), { collected: 2500, refunded: 0, currency: 'PLN' });
  assert.deepEqual(await finances('?from=2027-01-16'), { collected: 0, refunded: 500, currency: 'PLN' });
});
