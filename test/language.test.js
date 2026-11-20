import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

test('English checkout becomes available per Shop only when its English terms are published', async (t) => {
  const app = await startTestApp(t);
  const { body: original } = await app.request('/api/offer');
  const settings = '/api/staff/shops/' + original.shop.id + '/renter-copy';
  const auth = { authorization: staffAuthorization };
  const englishOffer = '/api/offer?language=en';
  const selection = { ...app.selection(original), language: 'en' };
  const hold = () => app.request('/api/checkouts', { method: 'POST', body: selection });
  const publish = (body) => app.request(settings, { method: 'POST', headers: auth, body });
  assert.equal((await app.request(englishOffer)).status, 400);
  assert.equal((await hold()).status, 400);
  assert.equal((await publish({ nameEn: 'Warsaw bike shop', descriptionEn: 'Ride by the river.', termsEn: '   ' })).status, 200);
  assert.deepEqual((await app.request('/api/offer')).body.languages, ['pl']);
  assert.equal((await hold()).status, 400);

  assert.equal((await publish({ termsEn: 'Please return the bikes before closing.' })).status, 200);
  const { status, body: offer } = await app.request(englishOffer);
  assert.equal(status, 200);
  assert.equal(offer.shop.name, 'Warsaw bike shop');
  assert.equal(offer.shop.description, 'Ride by the river.');
  assert.match(offer.shop.terms, /^Please return the bikes before closing\./);
  assert.deepEqual(offer.languages, ['pl', 'en']);
  const { status: holdStatus, body: checkout } = await hold();
  assert.equal(holdStatus, 201);
  assert.equal(checkout.language, 'en');
  assert.match(checkout.terms, /private link/i);
});
