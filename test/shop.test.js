import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const authorization = (user, password) => 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
const credentials = (Authorization = staffAuthorization) => ({ headers: { Authorization } });
const demoShopId = 'warszawa-demo';
const settingsPath = (shopId) => '/api/staff/shops/' + shopId + '/settings';
const staffRoute = (shopId, resource) => '/api/staff/shops/' + shopId + '/' + resource;
const post = (app, path, body, auth) => app.request(path, {
  method: 'POST', body, ...credentials(auth),
});

test('Właściciel zarządza swoimi punktami i przyznaje uprawnienie do zwrotów wyłącznie w przypisanym punkcie', async (t) => {
  const outsider = authorization('wlasciciel-innego', 'syntetyczne-inny');
  const worker = authorization('pracownik', 'syntetyczne-haslo');
  const app = await startTestApp(t, { demoOwners: [
    { username: 'wlasciciel-innego', password: 'syntetyczne-inny', partnerId: 'another-demo' },
  ] });

  const other = await post(app, '/api/staff/shops', { name: 'Drugi warszawski punkt' });
  assert.equal(other.status, 201);
  const ownerShops = await app.request('/api/staff/shops', credentials());
  assert.deepEqual(new Set(ownerShops.body.map(({ id }) => id)), new Set([demoShopId, other.body.id]));
  assert.deepEqual((await app.request('/api/staff/shops', credentials(outsider))).body, []);
  const foreignShop = await post(app, '/api/staff/shops', { name: 'Punkt innego Partnera' }, outsider);
  assert.equal(foreignShop.status, 201);
  assert.equal((await app.request(settingsPath(foreignShop.body.id), credentials())).status, 404);

  assert.equal((await post(app, '/api/staff/members', {
    username: 'pracownik', password: 'syntetyczne-haslo',
  })).status, 201);
  const memberPath = '/api/staff/members/pracownik/assignments';
  assert.equal((await post(app, memberPath, {
    shopId: demoShopId, canRefund: true,
  }, outsider)).status, 404);
  assert.equal((await post(app, memberPath, { shopId: demoShopId, canRefund: true })).status, 200);
  const workerShops = await app.request('/api/staff/shops', credentials(worker));
  assert.deepEqual(workerShops.body.map(({ id, canRefund }) => ({ id, canRefund })), [{ id: demoShopId, canRefund: true }]);
  assert.equal((await post(app, memberPath, { shopId: other.body.id, canRefund: true }, worker)).status, 403);
  assert.equal((await app.request(staffRoute(demoShopId, 'stock'), credentials(worker))).body[0].quantity, 1);
  const helmetStock = { itemId: 'kask', quantity: 1 };
  assert.equal((await post(app, staffRoute(demoShopId, 'stock'), helmetStock, worker)).status, 200);
  assert.equal((await post(app, staffRoute(other.body.id, 'stock'), helmetStock, worker)).status, 404);
  const { body: currentStock } = await app.request(staffRoute(demoShopId, 'stock'), credentials(worker));
  assert.equal(currentStock.find(({ id }) => id === 'kask').quantity, 1);

  const selection = app.selection((await app.request('/api/offer')).body);
  const foreignOffer = await app.request('/api/offer?shopId=' + foreignShop.body.id);
  assert.equal(foreignOffer.status, 200);
  assert.deepEqual(foreignOffer.body.slots, []);
  assert.ok(foreignOffer.body.equipment.length > 0);
  assert.ok(foreignOffer.body.equipment.every(({ quantity }) => quantity === 0));
  const foreignSelection = { ...selection, shopId: foreignShop.body.id };
  assert.equal((await app.request('/api/checkouts', { method: 'POST', body: foreignSelection })).status, 409);
  assert.equal((await post(app, staffRoute(foreignShop.body.id, 'stock'), {
    itemId: selection.categoryId, quantity: 1,
  }, outsider)).status, 200);

  const checkout = (await app.request('/api/checkouts', { method: 'POST', body: selection })).body;
  assert.equal((await app.request('/api/checkouts', {
    method: 'POST', body: foreignSelection,
  })).status, 201);
  const payment = (await app.request('/api/checkouts/' + checkout.id + '/payment', { method: 'POST', body: {
    email: 'renter@example.test', phone: '+48 500 123 456', riderHeight: 178, acceptedTerms: true,
  } })).body;
  const paymentId = payment.paymentUrl.split('/').at(-1);
  await app.request('/api/simulator/payments/' + paymentId + '/pay', { method: 'POST', body: { amount: 2000 } });
  const booking = (await app.request('/api/payment-notifications', { method: 'POST', body: { paymentId } })).body;
  assert.deepEqual((await app.request('/api/staff/bookings', credentials(worker))).body.map(({ id }) => id), [booking.bookingId]);
  assert.deepEqual((await app.request('/api/staff/bookings', credentials(outsider))).body, []);

  assert.equal((await post(app, settingsPath(demoShopId), { minimumNoticeMinutes: 90 }, worker)).status, 200);
  assert.equal((await post(app, settingsPath(demoShopId), { maxRentalMinutes: 60 }, worker)).status, 403);
  for (const [selected, auth] of [[demoShopId, outsider], [other.body.id, worker]]) {
    for (const resource of ['settings', 'stock', 'bookings']) {
      assert.equal((await app.request(staffRoute(selected, resource), credentials(auth))).status, 404);
    }
    assert.equal((await post(app, settingsPath(selected), { minimumNoticeMinutes: 1000 }, auth)).status, 404);
  }
  assert.equal((await app.request(settingsPath(demoShopId), credentials())).body.minimumNoticeMinutes, 90);
  const legalName = 'Syntetyczny Partner Warszawa';
  assert.equal((await post(app, '/api/staff/partner', { legalName }, worker)).status, 403);
  assert.equal((await post(app, '/api/staff/partner', { legalName })).status, 200);
  assert.equal((await app.request('/api/offer?shopId=' + other.body.id)).body.shop.seller.legalName, legalName);
  assert.equal((await post(app, memberPath, { shopId: demoShopId, canRefund: false })).status, 200);
  assert.equal((await app.request('/api/staff/shops', credentials(worker))).body[0].canRefund, false);
});

const weeklyHours = { mon: [], tue: [], wed: [], thu: [], fri: [['10:00', '16:00']], sat: [], sun: [] };

test('Kalendarz widżetu stosuje wyjątki świąteczne, granice najmu i aktualne minimalne wyprzedzenie', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T09:30:00.000Z' });
  const offer = () => app.request('/api/offer');
  const hold = (offerBody, slotId, returnAt) => app.request('/api/checkouts', {
    method: 'POST', body: { ...app.selection(offerBody), slotId, returnAt },
  });
  const settings = (body) => post(app, settingsPath(demoShopId), body);
  assert.equal((await settings({
    weeklyHours,
    holidayHours: { '2027-01-15': [['11:00', '15:00']] },
    minimumNoticeMinutes: 0,
    bookingHorizonMinutes: 120,
    maxRentalMinutes: 90,
  })).status, 200);
  assert.equal((await settings({ holidayHours: { '2027-02-30': [] } })).status, 400);
  assert.equal((await settings({ weeklyHours: { ...weeklyHours, fri: [['10:15', '18:00']] } })).status, 400);

  const { body } = await offer();
  const pickup = '2027-01-15T10:00:00.000Z';
  const horizon = '2027-01-15T11:30:00.000Z';
  assert.deepEqual(body.slots.map(({ pickupAt }) => pickupAt), [
    pickup, '2027-01-15T10:30:00.000Z', '2027-01-15T11:00:00.000Z', horizon,
  ]);
  const { body: options } = await app.request('/api/offer?pickupAt=' + encodeURIComponent(horizon));
  assert.deepEqual(options.slots.map(({ returnAt }) => returnAt), [
    '2027-01-15T12:00:00.000Z', '2027-01-15T12:30:00.000Z', '2027-01-15T13:00:00.000Z',
  ]);
  assert.equal((await hold(body, '2027-01-15T09:30:00.000Z', '2027-01-15T10:30:00.000Z')).status, 400);
  assert.equal((await hold(body, pickup, '2027-01-15T10:15:00.000Z')).status, 400);
  assert.equal((await hold(body, pickup, '2027-01-15T12:00:00.000Z')).status, 400);
  assert.equal((await hold(body, '2027-01-15T12:00:00.000Z', '2027-01-15T12:30:00.000Z')).status, 400);
  assert.equal((await hold(body, pickup, '2027-01-15T10:30:00.000Z')).status, 201);
  app.advance(0.01);
  assert.equal((await hold(body, pickup, '2027-01-15T10:30:00.000Z')).status, 400);

  assert.equal((await settings({ minimumNoticeMinutes: 90 })).status, 200);
  assert.deepEqual((await offer()).body.slots.map(({ pickupAt }) => pickupAt), [horizon]);
  assert.equal((await hold(body, '2027-01-15T11:00:00.000Z', '2027-01-15T12:00:00.000Z')).status, 400);
  assert.equal((await settings({ holidayHours: { '2027-01-15': [] } })).status, 200);
  assert.deepEqual((await offer()).body.slots, []);
});

test('Zmiana czasu w Warszawie pomija nieistniejące półgodziny i rozróżnia powtórzone godziny', async (t) => {
  const settings = {
    weeklyHours: { ...weeklyHours, fri: [], sun: [['01:30', '04:00']] },
    bookingHorizonMinutes: 300,
    maxRentalMinutes: 60,
  };
  const spring = await startTestApp(t, { date: '2027-03-27T23:00:00.000Z' });
  assert.equal((await post(spring, settingsPath(demoShopId), settings)).status, 200);
  const springOffer = (await spring.request('/api/offer')).body;
  assert.deepEqual(springOffer.slots.map(({ pickupAt }) => pickupAt), [
    '2027-03-28T00:30:00.000Z', '2027-03-28T01:00:00.000Z', '2027-03-28T01:30:00.000Z',
  ]);
  const springHold = await spring.request('/api/checkouts', {
    method: 'POST', body: { ...spring.selection(springOffer), returnAt: '2027-03-28T01:30:00.000Z' },
  });
  assert.equal(springHold.status, 201);
  assert.equal(springHold.body.total, 2000);

  const autumn = await startTestApp(t, { date: '2027-10-30T22:00:00.000Z' });
  assert.equal((await post(autumn, settingsPath(demoShopId), settings)).status, 200);
  const autumnOffer = (await autumn.request('/api/offer')).body;
  assert.deepEqual(autumnOffer.slots.map(({ pickupAt }) => pickupAt), [
    '2027-10-30T23:30:00.000Z', '2027-10-31T00:00:00.000Z', '2027-10-31T00:30:00.000Z',
    '2027-10-31T01:00:00.000Z', '2027-10-31T01:30:00.000Z', '2027-10-31T02:00:00.000Z', '2027-10-31T02:30:00.000Z',
  ]);
  const autumnHold = await autumn.request('/api/checkouts', { method: 'POST', body: {
    ...autumn.selection(autumnOffer), slotId: '2027-10-31T00:30:00.000Z', returnAt: '2027-10-31T01:00:00.000Z',
  } });
  assert.equal(autumnHold.status, 201);
  assert.equal(autumnHold.body.returnAt, '2027-10-31T01:00:00.000Z');
});
