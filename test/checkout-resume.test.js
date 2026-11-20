import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const draft = { email: 'powrot@example.test', phone: '', riderHeights: [null], acceptedTerms: false };
const post = (app, path, body, headers) => app.request(path, { method: 'POST', body, headers });
const staffHeaders = { Authorization: staffAuthorization };
const checkoutPath = (checkout) => '/api/checkouts/' + checkout.id;

async function begin(app) {
  const { body: offer } = await app.request('/api/offer');
  const { body: checkout, status } = await post(app, '/api/checkouts', {
    shopId: offer.shop.id,
    categoryId: offer.category.id,
    slotId: '2027-01-15T16:00:00.000Z',
    returnAt: '2027-01-15T17:00:00.000Z',
  });
  assert.equal(status, 201);
  return checkout;
}

async function sendLink(app, checkout, details = draft, requestId = randomUUID()) {
  return post(app, checkoutPath(checkout) + '/resume-link', { ...details, requestId });
}

const privateApi = (message) => '/api' + message.resumeUrl;

test('Prywatny link przywraca niepełny formularz oraz pierwotny termin blokady', async (t) => {
  const app = await startTestApp(t);
  const checkout = await begin(app);
  app.advance(3);
  const requestId = randomUUID();
  const first = await sendLink(app, checkout, draft, requestId);
  assert.equal(first.status, 201);
  assert.equal(first.body.to, draft.email);
  assert.match(first.body.resumeUrl, /^\/checkout-resume\/[a-zA-Z0-9_-]{43}$/);
  assert.match(first.body.subject, /dokończ/i);
  assert.ok(first.body.content.includes(first.body.resumeUrl));
  assert.equal(first.body.expiresAt, '2027-01-16T13:06:00.000Z');
  const retry = await sendLink(app, checkout, draft, requestId);
  assert.deepEqual(retry.body, first.body);
  assert.equal((await app.request('/api/checkout-resume/' + checkout.id)).status, 404);

  const { body: resumed } = await app.request(privateApi(first.body));
  assert.equal(resumed.checkout.status, 'held');
  assert.equal(resumed.checkout.expiresAt, '2027-01-15T13:18:00.000Z');
  assert.match(resumed.checkout.terms, /24 godzin/);
  assert.deepEqual(resumed.checkout.items, checkout.items);
  assert.deepEqual(resumed.draft, draft);
});

test('Po wygaśnięciu blokady link wymaga potwierdzenia aktualnej ceny i angażuje zapas tylko raz', async (t) => {
  const app = await startTestApp(t);
  const checkout = await begin(app);
  const { body: message } = await sendLink(app, checkout);
  const path = privateApi(message);
  app.advance(15);

  const before = await app.request(path);
  assert.equal(before.body.checkout.status, 'reconfirm');
  assert.equal(before.body.checkout.total, checkout.total);
  assert.equal((await post(app, checkoutPath(checkout) + '/payment', draft)).status, 409);

  const catalog = '/api/staff/shops/' + checkout.shopId + '/catalog';
  const rates = { hourlyRate: 3500, dayRate: 8000, fullDayRate: 10000 };
  assert.equal((await post(app, catalog, { id: checkout.categoryId, kind: 'bike', name: 'Rower turystyczny', ...rates }, staffHeaders)).status, 200);
  const confirm = (quoteVersion) => post(app, path + '/confirm', { quoteVersion });
  assert.equal((await confirm(before.body.checkout.quoteVersion)).status, 409);

  const updated = await app.request(path);
  assert.equal(updated.body.checkout.total, 3500);
  const attempts = await Promise.all([confirm(updated.body.checkout.quoteVersion), confirm(updated.body.checkout.quoteVersion)]);
  assert.deepEqual(attempts.map(({ status }) => status), [200, 200]);
  assert.equal(attempts[0].body.checkout.id, attempts[1].body.checkout.id);
  assert.notEqual(attempts[0].body.checkout.id, checkout.id);
  assert.equal(attempts[0].body.checkout.expiresAt, '2027-01-15T13:33:00.000Z');
  assert.deepEqual(attempts[0].body.draft, draft);
});

test('Link w ciągu 24 godzin pokazuje utratę dostępności, a potem wygasa', async (t) => {
  const app = await startTestApp(t);
  const checkout = await begin(app);
  const { body: message } = await sendLink(app, checkout);
  const path = privateApi(message);
  app.advance(15);
  const { body: preview } = await app.request(path);
  await post(app, '/api/staff/shops/' + checkout.shopId + '/stock',
    { itemId: checkout.categoryId, quantity: 0 }, staffHeaders);
  assert.equal((await post(app, path + '/confirm', { quoteVersion: preview.checkout.quoteVersion })).status, 409);
  const unavailable = await app.request(path);
  assert.equal(unavailable.body.checkout.status, 'unavailable');
  assert.match(unavailable.body.checkout.reason, /sprzęt/i);

  app.advance(1424);
  assert.equal((await app.request(path)).status, 200);
  app.advance(1);
  assert.equal((await app.request(path)).status, 410);
  assert.equal((await post(app, path + '/confirm', { quoteVersion: preview.checkout.quoteVersion })).status, 410);
});

test('Spóźniona weryfikacja rozpoczętej płatności wstrzymuje nową próbę i pokazuje wynik', async (t) => {
  const app = await startTestApp(t);
  const checkout = await begin(app);
  const { body: message } = await sendLink(app, checkout);
  const path = privateApi(message);
  const { body: payment } = await post(app, checkoutPath(checkout) + '/payment', {
    email: draft.email, phone: '+48 500 123 456', riderHeights: [182], acceptedTerms: true,
  });
  assert.equal(payment.status, 'payment');
  assert.equal((await app.request(path)).body.checkout.status, 'payment');
  const paymentId = payment.paymentUrl.split('/').at(-1);
  await post(app, '/api/simulator/payments/' + paymentId + '/pay', {});
  app.advance(15);
  assert.equal((await app.request(path)).body.checkout.status, 'processing');
  assert.equal((await post(app, path + '/confirm', {})).status, 409);
  assert.equal((await post(app, '/api/payment-notifications', { paymentId })).body.status, 'confirmed');
  const { body: confirmation } = await app.request(path);
  assert.equal(confirmation.checkout.status, 'confirmed');
  assert.deepEqual(confirmation.draft.riderHeights, [182]);
});
