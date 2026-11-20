import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const owner = { Authorization: staffAuthorization };
const shopId = 'warszawa-demo';
const shopPath = '/api/staff/shops/' + shopId;
const bike = { id: 'rower-turystyczny', name: 'Rower turystyczny', kind: 'bike', hourlyRate: 2000, dayRate: 8000, fullDayRate: 10000 };
const opening = [['10:00', '19:00']];
const weeklyHours = {
  mon: opening, tue: opening, wed: opening, thu: opening, fri: opening, sat: opening, sun: [['10:00', '15:00']],
};
const post = (app, path, body, headers) => app.request(path, { method: 'POST', body, headers });
const iso = (day, time) => '2027-01-' + day + 'T' + time + ':00.000Z';
const hold = (app, pickup, end, items = [{ itemId: bike.id, quantity: 1 }]) => post(app, '/api/checkouts', {
  shopId, slotId: pickup, returnAt: end, items,
});
const charge = (rate, amount, startsAt, endsAt) => ({ rate, amount, coveredPeriods: [{ startsAt, endsAt }] });

test('Publiczna wycena stosuje najtańsze stawki z ADR i blokuje sprzęt do planowanego zwrotu', async (t) => {
  const app = await startTestApp(t);
  assert.equal((await post(app, shopPath + '/settings', { weeklyHours }, owner)).status, 200);
  assert.equal((await post(app, shopPath + '/catalog', bike, owner)).status, 200);

  const samples = [
    { from: iso(16, '09:00'), to: iso(17, '11:00'), total: 12000 },
    { from: iso(16, '13:00'), to: iso(17, '11:00'), total: 10000 },
    { from: iso(16, '09:00'), to: iso(16, '10:30'), total: 4000 },
  ];
  for (const { from, to, total } of samples) {
    const offer = await app.request('/api/offer?' + new URLSearchParams({ pickupAt: from }));
    const slot = offer.body.slots.find(({ returnAt }) => returnAt === to);
    assert.equal(slot.total, total);
    assert.equal(slot.itemTotals[bike.id], total);
  }

  const [weekend] = samples;
  const saved = await hold(app, weekend.from, weekend.to);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.total, 12000);
  assert.equal(saved.body.returnAt, weekend.to);
  assert.deepEqual(saved.body.items[0].charges, [
    charge('day', 8000, weekend.from, iso(16, '18:00')),
    charge('hourly', 4000, iso(17, '09:00'), weekend.to),
  ]);
  assert.equal((await hold(app, iso(17, '10:00'), iso(17, '11:30'))).status, 409);
  assert.equal((await hold(app, weekend.to, iso(17, '11:30'))).status, 201);
});

test('Część godzinowa sumuje półgodziny otwarcia po obu stronach przerwy', async (t) => {
  const app = await startTestApp(t);
  const pickup = iso(16, '10:30');
  const end = iso(16, '12:30');
  const holidayHours = { '2027-01-16': [['10:00', '12:00'], ['13:00', '15:00']] };
  assert.equal((await post(app, shopPath + '/settings', { holidayHours }, owner)).status, 200);
  const held = await hold(app, pickup, end);
  assert.equal(held.status, 201);
  assert.equal(held.body.total, 2000);
  assert.deepEqual(held.body.items[0].charges, [{
    rate: 'hourly',
    amount: 2000,
    coveredPeriods: [
      { startsAt: pickup, endsAt: iso(16, '11:00') },
      { startsAt: iso(16, '12:00'), endsAt: end },
    ],
  }]);
});

test('Zmiany cennika i oferty nie zmieniają zapisanych opłat przy płatności ani po potwierdzeniu', async (t) => {
  const app = await startTestApp(t);
  const catalog = shopPath + '/catalog';
  const stock = shopPath + '/stock';
  const createWidget = (name, selection) => post(app, '/api/staff/widgets', {
    name, delivery: 'hosted', ...selection,
  }, owner);
  const { body: fixed } = await createWidget('Punkt', { shopId });
  const { body: picker } = await createWidget('Partner');
  const created = await post(app, catalog, { kind: 'accessory', name: 'Fotelik', bookingRate: 1500 }, owner);
  assert.equal(created.status, 201);
  const { id: seat } = created.body;
  assert.equal((await post(app, stock, { itemId: seat, quantity: 2 }, owner)).status, 200);
  assert.equal((await post(app, stock, { itemId: bike.id, quantity: 2 }, owner)).status, 200);
  assert.equal((await post(app, catalog, { ...bike, fullDayRate: 9000 }, owner)).status, 200);

  const pickup = iso(15, '15:00');
  const end = iso(16, '12:00');
  const items = [
    { itemId: bike.id, quantity: 2 },
    { itemId: seat, quantity: 2 },
    { itemId: 'zapiecie', quantity: 1 },
  ];
  const held = await hold(app, pickup, end, items);
  assert.equal(held.status, 201);
  assert.equal(held.body.total, 21000);
  const saved = held.body.items;
  assert.deepEqual(saved.find(({ itemId }) => itemId === bike.id).charges, [charge('24-hour', 9000, pickup, end)]);
  assert.deepEqual(saved.find(({ itemId }) => itemId === seat).charges, [charge('accessory', 1500, pickup, end)]);
  assert.deepEqual(saved.find(({ itemId }) => itemId === 'zapiecie').charges, [charge('accessory', 0, pickup, end)]);

  assert.equal((await post(app, catalog, { ...bike, name: 'Rower trekkingowy', fullDayRate: 7500 }, owner)).status, 200);
  assert.equal((await post(app, catalog, { id: seat, kind: 'accessory', name: 'Fotelik dziecięcy', bookingRate: 0 }, owner)).status, 200);
  const query = new URLSearchParams({ pickupAt: iso(16, '12:00'), shopId });
  for (const { id } of [picker, fixed]) {
    const offer = await app.request('/api/widgets/' + id + '/offer?' + query);
    assert.equal(offer.status, 200);
    assert.equal(offer.body.equipment.find(({ id }) => id === bike.id).name, 'Rower trekkingowy');
    assert.equal(offer.body.equipment.find(({ id }) => id === seat).name, 'Fotelik dziecięcy');
    const slot = offer.body.slots.find(({ returnAt }) => returnAt === iso(16, '16:00'));
    assert.equal(slot.itemTotals[bike.id], 7500);
    assert.equal(slot.itemTotals[seat], 0);
  }

  const heldPath = '/api/checkouts/' + held.body.id;
  assert.deepEqual((await app.request(heldPath)).body.items, saved);
  const payment = await post(app, heldPath + '/payment', {
    email: 'renter@example.test', phone: '+48 500 123 456', riderHeights: [171, 180], acceptedTerms: true,
  });
  assert.equal(payment.status, 200);
  assert.equal(payment.body.total, 21000);
  assert.deepEqual(payment.body.items, saved);
  const paymentId = payment.body.paymentUrl.split('/').at(-1);
  await post(app, '/api/simulator/payments/' + paymentId + '/pay', {});
  assert.equal((await post(app, '/api/payment-notifications', { paymentId })).body.status, 'confirmed');
  const { body: bookings } = await app.request('/api/staff/bookings', { headers: owner });
  assert.equal(bookings[0].total, 21000);
  assert.deepEqual(bookings[0].items, saved);

  const { body: confirmation } = await app.request(heldPath + '/confirmation');
  const { body: renterView } = await app.request('/api' + confirmation.bookingUrl.replace('/booking/', '/bookings/'));
  assert.deepEqual(renterView.items, saved);
});

test('W 74-godzinnym wynajmie pierwsza opłata 24-godzinna kończy się dokładnie na granicy zwrotu', async (t) => {
  const app = await startTestApp(t);
  const alwaysOpen = Object.fromEntries(Object.keys(weeklyHours).map((day) => [day, [['00:00', '24:00']]]));
  assert.equal((await post(app, shopPath + '/settings', { weeklyHours: alwaysOpen, maxRentalMinutes: 4440 }, owner)).status, 200);
  assert.equal((await post(app, shopPath + '/catalog', { ...bike, dayRate: null }, owner)).status, 200);
  const pickup = iso(15, '15:00');
  const end = iso(18, '17:00');
  const held = await hold(app, pickup, end);
  assert.equal(held.status, 201);
  assert.equal(held.body.total, 34000);
  assert.deepEqual(held.body.items[0].charges, [
    charge('24-hour', 10000, pickup, iso(16, '15:00')),
    charge('24-hour', 10000, iso(16, '15:00'), iso(17, '15:00')),
    charge('24-hour', 10000, iso(17, '15:00'), iso(18, '15:00')),
    charge('hourly', 4000, iso(18, '15:00'), end),
  ]);
});

test('Pozostałe części godzinowe przed i po opłacie dziennej zaokrąglają się łącznie', async (t) => {
  const app = await startTestApp(t);
  const pickup = iso(16, '17:30');
  const end = iso(18, '09:30');
  assert.equal((await post(app, shopPath + '/settings', { weeklyHours }, owner)).status, 200);
  assert.equal((await post(app, shopPath + '/catalog', { ...bike, dayRate: 5000, fullDayRate: null }, owner)).status, 200);
  const held = await hold(app, pickup, end);
  assert.equal(held.status, 201);
  assert.equal(held.body.total, 7000);
  assert.deepEqual(held.body.items[0].charges, [
    {
      rate: 'hourly',
      amount: 2000,
      coveredPeriods: [
        { startsAt: pickup, endsAt: iso(16, '18:00') },
        { startsAt: iso(18, '09:00'), endsAt: end },
      ],
    },
    charge('day', 5000, iso(17, '09:00'), iso(17, '14:00')),
  ]);
});

test('Opłata 24-godzinna pokrywa 24 godziny rzeczywiste podczas zmiany czasu', async (t) => {
  const app = await startTestApp(t, { date: '2027-03-26T13:00:00.000Z' });
  const alwaysOpen = Object.fromEntries(Object.keys(weeklyHours).map((day) => [day, [['00:00', '24:00']]]));
  assert.equal((await post(app, shopPath + '/settings', { weeklyHours: alwaysOpen }, owner)).status, 200);
  assert.equal((await post(app, shopPath + '/catalog', { ...bike, dayRate: null }, owner)).status, 200);
  // Odbiór o 10:00 CET, zwrot o 11:00 CEST następnego dnia.
  const pickup = '2027-03-27T09:00:00.000Z';
  const end = '2027-03-28T09:00:00.000Z';
  const held = await hold(app, pickup, end);
  assert.equal(held.status, 201);
  assert.equal(held.body.total, 10000);
  assert.deepEqual(held.body.items[0].charges, [charge('24-hour', 10000, pickup, end)]);
});
