import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const source = 'warszawa-demo';
const bikeId = 'rower-turystyczny';
const shopPath = (shopId, resource) => '/api/staff/shops/' + shopId + '/' + resource;
const ownerRequest = (app, path, body, auth = staffAuthorization) => app.request(path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Authorization: auth },
  body,
});

test('Właściciel kopiuje konfigurację punktu, a jego widżet stosuje własną dostępność i niezależne ustawienia', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T09:30:00.000Z' });
  const request = (path, body) => ownerRequest(app, path, body);
  const configure = (shopId, resource, body) => request(shopPath(shopId, resource), body);
  const { body: destination } = await request('/api/staff/shops', { name: 'Punkt nad Wisłą' });
  const settings = {
    minimumNoticeMinutes: 60,
    bookingHorizonMinutes: 240,
    maxRentalMinutes: 90,
    turnaroundBufferMinutes: 30,
    weeklyHours: { mon: [], tue: [], wed: [], thu: [], fri: [['11:30', '17:00']], sat: [], sun: [] },
    holidayHours: { '2027-01-15': [['11:00', '14:00']] },
  };
  const bike = { id: bikeId, kind: 'bike', name: 'Rower trekkingowy', hourlyRate: 3200, dayRate: 7000, fullDayRate: 9500 };
  assert.equal((await configure(source, 'settings', settings)).status, 200);
  assert.equal((await configure(source, 'catalog', bike)).status, 200);
  const { body: seat } = await configure(source, 'catalog', { kind: 'accessory', name: 'Fotelik', bookingRate: 1200 });
  assert.equal((await configure(source, 'stock', { itemId: seat.id, quantity: 4 })).status, 200);
  assert.equal((await configure(source, 'stock', { itemId: bikeId, quantity: 8 })).status, 200);
  assert.equal((await configure(destination.id, 'stock', { itemId: bikeId, quantity: 2 })).status, 200);
  const { body: basket } = await configure(destination.id, 'catalog', {
    kind: 'accessory', name: 'Koszyk', bookingRate: 300,
  });
  assert.equal((await configure(destination.id, 'stock', { itemId: basket.id, quantity: 2 })).status, 200);
  const { body: widget } = await request('/api/staff/widgets', {
    name: 'Rezerwacje nad Wisłą', shopId: destination.id, delivery: 'hosted',
  });

  assert.equal((await configure(destination.id, 'copy-configuration', { sourceShopId: source })).status, 200);
  assert.deepEqual((await configure(destination.id, 'settings')).body, settings);
  const catalog = (await configure(destination.id, 'catalog')).body;
  assert.deepEqual(catalog.find(({ id }) => id === bikeId), { ...bike, quantity: 2 });
  assert.deepEqual(catalog.find(({ id }) => id === seat.id), { ...seat, quantity: 0 });
  assert.deepEqual(catalog.find(({ id }) => id === basket.id), { ...basket, quantity: 2 });

  const widgetOffer = (pickupAt) => app.request('/api/widgets/' + widget.id + '/offer' +
    (pickupAt ? '?' + new URLSearchParams({ pickupAt }) : ''));
  const pickupAt = '2027-01-15T10:30:00.000Z';
  const returnAt = '2027-01-15T11:00:00.000Z';
  const offer = (await widgetOffer()).body;
  assert.equal(offer.shop.name, 'Punkt nad Wisłą');
  assert.equal(offer.slots[0].pickupAt, pickupAt);
  const slot = (await widgetOffer(pickupAt)).body.slots.find((slot) => slot.returnAt === returnAt);
  assert.equal(slot.itemTotals[bikeId], 3200);
  assert.equal(slot.itemTotals[seat.id], 1200);
  assert.equal(slot.availableQuantities[bikeId], 2);
  assert.equal(slot.availableQuantities[seat.id], 0);

  const hold = (slotId, endsAt, quantity, shopId = destination.id) => app.request('/api/checkouts', {
    method: 'POST', body: { shopId, slotId, returnAt: endsAt, items: [{ itemId: bikeId, quantity }] },
  });
  assert.equal((await hold(pickupAt, returnAt, 3)).status, 409);
  assert.equal((await hold(pickupAt, returnAt, 2)).body.total, 6400);
  assert.equal((await hold(returnAt, '2027-01-15T11:30:00.000Z', 1)).status, 409);
  assert.equal((await hold(pickupAt, returnAt, 3, source)).body.total, 9600);

  assert.equal((await configure(source, 'settings', { holidayHours: { '2027-01-15': [] } })).status, 200);
  assert.equal((await configure(source, 'catalog', { ...bike, hourlyRate: 4600 })).status, 200);
  assert.equal((await configure(destination.id, 'catalog', { ...seat, bookingRate: 900 })).status, 200);
  assert.equal((await configure(destination.id, 'stock', { itemId: seat.id, quantity: 1 })).status, 200);
  assert.equal((await widgetOffer()).body.slots[0].pickupAt, pickupAt);
  const afterEdit = (await widgetOffer(pickupAt)).body.slots.find((slot) => slot.returnAt === returnAt);
  assert.equal(afterEdit.itemTotals[bikeId], 3200);
  assert.equal(afterEdit.itemTotals[seat.id], 900);
  assert.equal(afterEdit.availableQuantities[seat.id], 1);
  assert.deepEqual((await configure(source, 'catalog')).body.find(({ id }) => id === seat.id), { ...seat, quantity: 4 });
});

test('Kopiowanie wymaga właściciela i dostępu do obu punktów tego samego Partnera', async (t) => {
  const foreignOwner = 'Basic ' + Buffer.from('inny-wlasciciel:syntetyczne-haslo').toString('base64');
  const worker = 'Basic ' + Buffer.from('pracownik:syntetyczne-haslo').toString('base64');
  const app = await startTestApp(t, { demoOwners: [
    { username: 'inny-wlasciciel', password: 'syntetyczne-haslo', partnerId: 'inny-partner' },
  ] });
  const request = (path, body, auth) => ownerRequest(app, path, body, auth);
  const { body: destination } = await request('/api/staff/shops', { name: 'Punkt lokalny' });
  const { body: foreign } = await request('/api/staff/shops', { name: 'Punkt innego Partnera' }, foreignOwner);
  assert.equal((await request('/api/staff/members', {
    username: 'pracownik', password: 'syntetyczne-haslo',
  })).status, 201);
  for (const shopId of [source, destination.id]) {
    assert.equal((await request('/api/staff/members/pracownik/assignments', { shopId, canRefund: false })).status, 200);
  }

  const copy = (target, sourceShopId, auth) => request(shopPath(target, 'copy-configuration'), { sourceShopId }, auth);
  const settingsPath = shopPath(destination.id, 'settings');
  assert.equal((await request(settingsPath, { minimumNoticeMinutes: 180 })).status, 200);
  assert.equal((await copy(destination.id, source, worker)).status, 403);
  assert.equal((await copy(destination.id, foreign.id)).status, 404);
  assert.equal((await copy(foreign.id, source)).status, 404);
  assert.equal((await copy(destination.id, destination.id)).status, 400);
  assert.equal((await request(settingsPath)).body.minimumNoticeMinutes, 180);
  assert.equal((await request(shopPath(foreign.id, 'settings'), undefined, foreignOwner)).body.minimumNoticeMinutes, 30);
});
