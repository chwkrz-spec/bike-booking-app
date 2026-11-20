import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const bike = 'rower-turystyczny';
const childBike = 'rower-dzieciecy';
const helmet = 'kask';
const staffHeaders = { Authorization: staffAuthorization };
const line = (itemId, quantity) => ({ itemId, quantity });
const post = (app, path, body, headers) => app.request(path, { method: 'POST', body, headers });
const hold = (app, shopId, slot, items) => post(app, '/api/checkouts', {
  shopId, slotId: slot.pickupAt, returnAt: slot.returnAt, items,
});
const overnight = { pickupAt: '2027-01-15T16:00:00.000Z', returnAt: '2027-01-16T10:00:00.000Z' };

test('Tylko jeden koszyk zajmuje ostatni kask, a przegrany nie blokuje pozostałych pozycji', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const id = offer.shop.id;
  const stock = '/api/staff/shops/' + id + '/stock';
  assert.equal((await post(app, stock, line(helmet, 1), staffHeaders)).status, 200);

  const attempts = [
    [line(bike, 1), line(helmet, 1)],
    [line(childBike, 1), line(helmet, 1)],
  ];
  const results = await Promise.all(attempts.map((items) => hold(app, id, overnight, items)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
  const failed = results.findIndex(({ status }) => status === 409);
  assert.equal((await hold(app, id, overnight, [attempts[failed][0]])).status, 201);

  const nextMorning = { pickupAt: '2027-01-16T09:00:00.000Z', returnAt: '2027-01-16T09:30:00.000Z' };
  assert.equal((await hold(app, id, nextMorning, attempts[1 - failed])).status, 409);

  const otherShop = await post(app, '/api/staff/shops', { name: 'Punkt testowy' }, staffHeaders);
  assert.equal((await hold(app, otherShop.body.id, overnight, attempts[1 - failed])).status, 201);
});

test('Dostępność uwzględnia szczyt zajętości i bufor między kolejnymi odbiorami', async (t) => {
  const app = await startTestApp(t);
  const { shop } = (await app.request('/api/offer')).body;
  const settingsPath = '/api/staff/shops/' + shop.id + '/settings';
  const period = (from, to) => ({
    pickupAt: '2027-01-15T' + from + ':00.000Z',
    returnAt: '2027-01-15T' + to + ':00.000Z',
  });

  assert.equal((await hold(app, shop.id, period('14:00', '14:30'), [line(childBike, 1)])).status, 201);
  assert.equal((await hold(app, shop.id, period('14:30', '15:00'), [line(childBike, 1)])).status, 201);
  assert.equal((await hold(app, shop.id, period('14:00', '15:00'), [line(childBike, 1)])).status, 201);
  assert.equal((await hold(app, shop.id, period('15:00', '16:00'), [line(childBike, 2)])).status, 201);

  assert.equal((await post(app, settingsPath, { turnaroundBufferMinutes: 30 }, staffHeaders)).status, 200);
  assert.equal((await hold(app, shop.id, period('16:00', '16:30'), [line(childBike, 1)])).status, 409);
  assert.equal((await hold(app, shop.id, period('16:30', '17:00'), [line(childBike, 1)])).status, 201);
});

const renter = { email: 'koszyk@example.test', phone: '+48 500 123 456', acceptedTerms: true };
const pickup = { pickupAt: '2027-01-15T14:00:00.000Z', returnAt: '2027-01-15T16:00:00.000Z' };

test('Płatność za kilka kategorii wymaga jednego wzrostu na każdy rower', async (t) => {
  const app = await startTestApp(t);
  const { shop } = (await app.request('/api/offer')).body;
  const items = [line(childBike, 2), line(bike, 1), line(helmet, 3)];
  const checkout = await hold(app, shop.id, pickup, items);
  assert.equal(checkout.body.total, 11_500);
  assert.deepEqual(checkout.body.items.map(({ itemId, quantity }) => line(itemId, quantity)), [
    line(bike, 1), line(childBike, 2), line(helmet, 3),
  ]);

  const pay = (heights) => post(app, '/api/checkouts/' + checkout.body.id + '/payment', {
    ...renter, riderHeights: heights,
  });
  assert.equal((await pay([176])).status, 400);
  assert.equal((await pay([176, 110, 251])).status, 400);
  const payment = await pay([176, 110, 127]);
  assert.equal(payment.status, 200);
  const paymentId = payment.body.paymentUrl.split('/').at(-1);
  await post(app, '/api/simulator/payments/' + paymentId + '/pay', {});
  assert.equal((await post(app, '/api/payment-notifications', { paymentId })).body.status, 'confirmed');
  const { body: bookings } = await app.request('/api/staff/bookings', { headers: staffHeaders });
  assert.deepEqual(bookings[0].riderHeights, [176, 110, 127]);
  assert.deepEqual(bookings[0].items, checkout.body.items);

  const confirmation = await app.request('/api/checkouts/' + checkout.body.id + '/confirmation');
  const privatePath = '/api' + confirmation.body.bookingUrl.replace('/booking/', '/bookings/');
  const { body: details } = await app.request(privatePath);
  assert.deepEqual(details.items, checkout.body.items);
  assert.equal(details.canCancel, true);

  const assignment = [
    { itemId: bike, units: ['T-01'] },
    { itemId: childBike, units: ['D-01', 'D-02'] },
  ];
  const assignmentPath = '/api/staff/shops/' + shop.id + '/bookings/' + bookings[0].id + '/pickup';
  assert.equal((await post(app, assignmentPath, { items: assignment }, staffHeaders)).status, 409);
  app.advance(57);
  assert.equal((await post(app, assignmentPath, { items: [
    assignment[0], { itemId: childBike, units: ['D-01', 'd-01'] },
  ] }, staffHeaders)).status, 400);
  const assigned = await post(app, assignmentPath, { items: assignment }, staffHeaders);
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.items, assignment);
  assert.equal((await post(app, privatePath + '/cancel', {})).status, 409);
  assert.equal((await post(app, '/api/staff/bookings/' + bookings[0].id + '/cancel', {}, staffHeaders)).status, 409);

});

test('Spóźniona płatność za koszyk jest zwracana, gdy kask został zajęty przez innego gościa', async (t) => {
  const app = await startTestApp(t);
  const { shop } = (await app.request('/api/offer')).body;
  assert.equal((await post(app, '/api/staff/shops/' + shop.id + '/stock', line(helmet, 1), staffHeaders)).status, 200);
  const first = await hold(app, shop.id, pickup, [line(bike, 1), line(helmet, 1)]);
  const payment = await post(app, '/api/checkouts/' + first.body.id + '/payment', {
    ...renter, riderHeights: [176],
  });
  const paymentId = payment.body.paymentUrl.split('/').at(-1);
  await post(app, '/api/simulator/payments/' + paymentId + '/pay', {});
  app.advance(15);

  assert.equal((await hold(app, shop.id, pickup, [line(childBike, 1), line(helmet, 1)])).status, 201);
  const notify = () => post(app, '/api/payment-notifications', { paymentId });
  const [one, two] = await Promise.all([notify(), notify()]);
  assert.equal(one.body.status, 'refund_started');
  assert.deepEqual(one, two);
  const { body: paymentStatus } = await app.request('/api/simulator/payments/' + paymentId);
  assert.deepEqual(paymentStatus.refund, { amount: 4500, id: one.body.refundId });
  assert.equal((await hold(app, shop.id, pickup, [line(bike, 1)])).status, 201);
});
