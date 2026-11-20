import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const staff = { Authorization: staffAuthorization };
const email = 'wynajem@example.test';
const shopPath = (shopId, resource) => '/api/staff/shops/' + shopId + '/' + resource;
const post = (app, path, body, headers) => app.request(path, { method: 'POST', body, headers });
const send = (app, selection, extra) => post(app, shopPath(selection.shopId, 'payment-links'), { ...selection, email, ...extra }, staff);

test('Wysłanie prywatnego linku tworzy jedną 15-minutową blokadę po cenie widżetu', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const selection = { ...app.selection(offer), requestId: randomUUID() };
  const sent = await send(app, selection);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.to, email);
  assert.match(sent.body.message.content, /Rower turystyczny × 1/);
  assert.match(sent.body.message.content, /20,00\sPLN/);
  assert.match(sent.body.message.content, /14:18/);
  assert.ok(sent.body.message.content.includes(sent.body.checkoutUrl));
  assert.equal(sent.body.checkout.total, offer.slots[0].total);
  assert.equal(sent.body.checkout.expiresAt, '2027-01-15T13:18:00.000Z');
  assert.match(sent.body.checkoutUrl, /^\/staff-checkout\/[\w-]+$/);

  app.advance(8);
  const retry = await send(app, selection);
  assert.deepEqual(retry.body.message, sent.body.message);
  assert.equal(retry.body.checkout.expiresAt, sent.body.checkout.expiresAt);

  const path = '/api/checkouts/' + sent.body.checkout.id;
  const opened = await app.request('/api' + sent.body.checkoutUrl);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.channel, 'staff');
  assert.ok(opened.body.shop.seller.nip);
  assert.equal((await app.request('/api/staff-checkout/' + randomUUID())).status, 404);
  assert.equal((await post(app, path + '/resume-link', { email, requestId: randomUUID() })).status, 409);
  assert.equal(opened.body.expiresAt, sent.body.checkout.expiresAt);
  const details = { riderHeights: [176], termsVersion: opened.body.termsVersion };
  assert.equal((await post(app, path + '/payment', details)).status, 400);
  assert.equal((await post(app, path + '/payment', { ...details, riderHeights: [], acceptedTerms: true })).status, 400);
  const pay = () => post(app, path + '/payment', { ...details, acceptedTerms: true });
  const first = await pay();
  assert.equal(first.status, 200);
  assert.equal(first.body.expiresAt, sent.body.checkout.expiresAt);
  assert.equal((await pay()).body.paymentUrl, first.body.paymentUrl);
  const paymentId = first.body.paymentUrl.split('/').at(-1);
  assert.equal((await post(app, '/api/payment-notifications', { paymentId })).body.status, 'payment');
  await post(app, '/api/simulator/payments/' + paymentId + '/pay', {});
  assert.equal((await post(app, '/api/payment-notifications', { paymentId })).body.status, 'confirmed');
  assert.equal((await app.request(path + '/confirmation')).body.to, email);
});

test('Link respektuje granicę 15 minut i pierwszeństwo dłuższego minimum punktu', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T13:15:00.001Z' });
  const { body: widget } = await app.request('/api/offer');
  const { shop, category } = widget;
  const selection = (slotId) => ({ shopId: shop.id, categoryId: category.id, slotId });
  const exact = { ...selection('2027-01-15T13:30:00.000Z'), returnAt: '2027-01-15T14:00:00.000Z' };
  const later = selection('2027-01-15T14:00:00.000Z');

  assert.equal((await send(app, exact)).status, 400);
  assert.equal((await app.request(shopPath(shop.id, 'assisted-offer'), { headers: staff })).body.slots[0].id, later.slotId);
  assert.equal((await post(app, shopPath(shop.id, 'settings'), { minimumNoticeMinutes: 45 }, staff)).status, 200);
  assert.equal((await send(app, later)).status, 400);
  assert.equal((await app.request(shopPath(shop.id, 'assisted-offer'), { headers: staff })).body.slots[0].id,
    '2027-01-15T14:30:00.000Z');

  const boundary = await startTestApp(t, { date: '2027-01-15T13:15:00.000Z' });
  assert.equal((await post(boundary, shopPath(shop.id, 'settings'), { minimumNoticeMinutes: 0 }, staff)).status, 200);
  assert.equal((await post(boundary, '/api/checkouts', exact)).status, 400);
  assert.equal((await send(boundary, exact)).status, 201);
  assert.equal((await post(boundary, shopPath(shop.id, 'settings'), { minimumNoticeMinutes: 45 }, staff)).status, 200);
  assert.equal((await send(boundary, later)).status, 201);
});

test('Widżet i obsługa nie mogą jednocześnie zająć ostatniej sztuki, a wygaśnięcie ją zwalnia', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const selection = app.selection(offer);
  const [web, assisted] = await Promise.all([
    post(app, '/api/checkouts', selection),
    send(app, selection),
  ]);
  assert.deepEqual([web.status, assisted.status].sort(), [201, 409]);
  app.advance(15);
  assert.equal((await send(app, selection)).status, 201);
});

test('Tylko pracownik przypisany do punktu lub właściciel może wysłać link z jego oferty', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const selection = app.selection(offer);
  const without = await post(app, shopPath(selection.shopId, 'payment-links'), { ...selection, email });
  assert.equal(without.status, 401);
  const newShop = await post(app, '/api/staff/shops', { name: 'Drugi Punkt' }, staff);
  assert.equal(newShop.status, 201);
  const { body: remote } = await app.request('/api/offer?shopId=' + newShop.body.id);
  const remoteSelection = app.selection(remote);
  const create = await post(app, '/api/staff/members', { username: 'operator', password: 'synthetic-password' }, staff);
  assert.equal(create.status, 201);
  assert.equal((await post(app, '/api/staff/members/operator/assignments', {
    shopId: selection.shopId, assigned: true, canRefund: false,
  }, staff)).status, 200);
  const worker = { Authorization: 'Basic ' + Buffer.from('operator:synthetic-password').toString('base64') };
  assert.equal((await app.request(shopPath(remote.shop.id, 'assisted-offer'), { headers: worker })).status, 404);
  assert.equal((await post(app, shopPath(remote.shop.id, 'payment-links'), { ...remoteSelection, email }, worker)).status, 404);
  assert.equal((await post(app, shopPath(selection.shopId, 'payment-links'), { ...remoteSelection, email }, worker)).body.checkout.shopId, selection.shopId);
});
