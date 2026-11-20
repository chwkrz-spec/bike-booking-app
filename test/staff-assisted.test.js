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

test('Podmiana linku pozwala opłacić poprawiony wybór, a zweryfikowaną płatność za stary zwraca w całości tylko raz', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const selection = app.selection(offer);
  const { body: original } = await send(app, selection);
  const startPayment = async (link) => {
    const { body: { termsVersion } } = await app.request('/api' + link.checkoutUrl);
    const payment = await post(app, '/api/checkouts/' + link.checkout.id + '/payment', {
      riderHeights: [176], acceptedTerms: true, termsVersion,
    });
    assert.equal(payment.status, 200);
    return payment.body.paymentUrl.split('/').at(-1);
  };
  const notify = (paymentId) => post(app, '/api/payment-notifications', { paymentId });
  const simulator = (paymentId) => '/api/simulator/payments/' + paymentId;
  const originalPayment = await startPayment(original);
  assert.equal((await post(app, simulator(originalPayment) + '/pay', {})).body.status, 'paid');
  app.advance(2);

  const path = shopPath(selection.shopId, 'payment-links/' + original.checkout.id + '/replace');
  const corrected = {
    ...selection, slotId: '2027-01-15T15:00:00.000Z', returnAt: '2027-01-15T16:30:00.000Z',
    email, requestId: randomUUID(),
  };
  const replacement = await post(app, path, corrected, staff);
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.body.checkoutUrl, original.checkoutUrl);
  assert.ok(replacement.body.message.content.includes(replacement.body.checkoutUrl));
  assert.equal(replacement.body.checkout.expiresAt, '2027-01-15T13:20:00.000Z');
  assert.equal(replacement.body.checkout.total, 4000);
  assert.deepEqual(await post(app, path, corrected, staff), replacement);
  assert.equal((await post(app, path, { ...corrected, requestId: randomUUID() }, staff)).status, 409);

  const former = await app.request('/api' + original.checkoutUrl);
  assert.equal(former.body.status, 'replaced');
  assert.equal(former.body.paymentUrl, undefined);
  assert.equal((await post(app, '/api/checkouts/' + original.checkout.id + '/payment', {})).body.status, 'replaced');
  assert.ok((await app.request('/api/offer')).body.slots.some(({ id }) => id === selection.slotId));

  const newPayment = await startPayment(replacement.body);
  assert.equal((await post(app, simulator(newPayment) + '/pay', {})).body.status, 'paid');
  const [refund, confirmed, retry] = await Promise.all([
    notify(originalPayment), notify(newPayment), notify(originalPayment),
  ]);
  assert.equal(refund.body.status, 'refund_started');
  assert.deepEqual(retry, refund);
  assert.deepEqual(await notify(originalPayment), refund);
  assert.equal(confirmed.body.status, 'confirmed');
  assert.deepEqual(await notify(newPayment), confirmed);
  assert.deepEqual((await app.request(simulator(originalPayment))).body.refund, { id: refund.body.refundId, amount: 2000 });
  assert.equal((await app.request('/api/checkouts/' + original.checkout.id + '/payment-failure')).body.to, email);
  const { body: bookings } = await app.request('/api/staff/bookings', { headers: staff });
  assert.deepEqual(bookings.map(({ id, pickupAt, total }) => [id, pickupAt, total]),
    [[confirmed.body.bookingId, corrected.slotId, 4000]]);
});

test('Korekta i widżet rywalizują o zapas, a przegrana korekta zachowuje stary link i blokadę', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const selection = { ...app.selection(offer), returnAt: '2027-01-15T14:30:00.000Z' };
  const { body: original } = await send(app, selection);
  const path = shopPath(selection.shopId, 'payment-links/' + original.checkout.id + '/replace');
  const corrected = { ...selection, returnAt: '2027-01-15T15:00:00.000Z', email };
  const rival = { ...selection, slotId: selection.returnAt, returnAt: corrected.returnAt };
  const checkoutPath = '/api' + original.checkoutUrl;
  const replaceOffer = new URLSearchParams({ pickupAt: selection.slotId, replacing: original.checkout.id });
  const preview = await app.request(shopPath(selection.shopId, 'assisted-offer?' + replaceOffer), { headers: staff });
  assert.ok(preview.body.slots.some(({ returnAt }) => returnAt === corrected.returnAt));
  assert.equal((await post(app, path, { ...corrected, items: [{ itemId: selection.categoryId, quantity: 2 }] }, staff)).status, 409);
  assert.equal((await app.request(checkoutPath)).body.status, 'held');
  assert.equal((await post(app, '/api/checkouts', selection)).status, 409);

  const [replacement, widget] = await Promise.all([
    post(app, path, corrected, staff),
    post(app, '/api/checkouts', rival),
  ]);
  assert.deepEqual([replacement.status, widget.status].sort(), [201, 409]);
  const listPath = shopPath(selection.shopId, 'payment-links');
  const { body: links } = await app.request(listPath, { headers: staff });
  if (replacement.status === 409) {
    const { body: active } = await app.request(checkoutPath);
    assert.equal(active.status, 'held');
    assert.equal(active.expiresAt, original.checkout.expiresAt);
    assert.deepEqual(links.map(({ id }) => id), [original.checkout.id]);
    const pay = await post(app, '/api/checkouts/' + active.id + '/payment', {
      riderHeights: [175], acceptedTerms: true, termsVersion: active.termsVersion,
    });
    assert.equal(pay.body.status, 'payment');
  } else {
    assert.equal((await app.request(checkoutPath)).body.status, 'replaced');
    assert.deepEqual(links.map(({ id }) => id), [replacement.body.checkout.id]);
  }
  assert.equal((await post(app, '/api/checkouts', selection)).status, 409);
});
