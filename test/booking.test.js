import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

test('Gość wybiera dostępny termin, widzi cenę i sprzedawcę, a potwierdzenie zajmuje rower na 15 minut', async (t) => {
  const app = await startTestApp(t);
  const offer = await app.request('/api/offer');
  assert.equal(offer.status, 200);
  assert.deepEqual(offer.body.shop.seller, {
    legalName: 'Rowerowy Punkt Testowy sp. z o.o.',
    address: 'ul. Przykładowa 1, 00-001 Warszawa',
    nip: '0000000000',
  });
  assert.equal(offer.body.currency, 'PLN');
  assert.equal(offer.body.slots[0].total, 2000);

  const selection = app.selection(offer.body);
  const hold = await app.request('/api/checkouts', { method: 'POST', body: selection });
  assert.equal(hold.status, 201);
  assert.equal(hold.body.status, 'held');
  assert.equal(hold.body.expiresAt, '2027-01-15T13:18:00.000Z');
  assert.equal(hold.body.total, 2000);
  assert.equal((await app.request('/api/checkouts', { method: 'POST', body: selection })).status, 409);
  assert.equal((await app.request(`/api/checkouts/${hold.body.id}`)).body.expiresAt, hold.body.expiresAt);
});

const renter = {
  email: 'rowerzysta@example.test',
  phone: '+48 500 123 456',
  riderHeight: 176,
  acceptedTerms: true,
};

async function startHold(app, extra = {}) {
  const { body } = await app.request('/api/offer');
  const selection = { ...app.selection(body), ...extra };
  const hold = await app.request('/api/checkouts', { method: 'POST', body: selection });
  return { selection, hold: hold.body, path: '/api/checkouts/' + hold.body.id };
}

test('Ponowienie potwierdzenia zachowuje blokadę, a ważny formularz przenosi ją do osobnego okna płatności', async (t) => {
  const app = await startTestApp(t);
  const initial = await startHold(app, { requestId: '1ddf263a-25b8-49e5-800e-9809387c9246' });
  app.advance(8);
  const retried = await app.request('/api/checkouts', { method: 'POST', body: initial.selection });
  assert.equal(retried.body.id, initial.hold.id);
  assert.equal(retried.body.expiresAt, '2027-01-15T13:18:00.000Z');

  const pay = (details) => app.request(initial.path + '/payment', { method: 'POST', body: details });
  for (const invalid of [{ acceptedTerms: false }, { email: 'x' }, { phone: '' }, { riderHeight: 0 }]) {
    assert.equal((await pay({ ...renter, ...invalid })).status, 400);
  }
  const started = await pay(renter);
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'payment');
  assert.equal(started.body.expiresAt, '2027-01-15T13:26:00.000Z');
  assert.match(started.body.paymentUrl, /^\/payment-simulator\/[\w-]+$/);

  app.advance(8);
  assert.equal((await app.request(initial.path)).body.expiresAt, started.body.expiresAt);
  assert.equal((await pay(renter)).body.paymentUrl, started.body.paymentUrl);
  assert.equal((await app.request('/api/checkouts', { method: 'POST', body: { ...initial.selection, requestId: undefined } })).status, 409);
  app.advance(7);
  assert.equal((await app.request(initial.path)).body.status, 'expired');
  assert.equal((await app.request(initial.path + '/payment', { method: 'POST', body: renter })).status, 409);
  assert.equal((await app.request('/api/checkouts', { method: 'POST', body: { ...initial.selection, requestId: undefined } })).status, 201);
});

test('Wygaśnięcie blokady formularza umożliwia innemu gościowi wybór tego samego terminu', async (t) => {
  const app = await startTestApp(t);
  const { selection, path } = await startHold(app);
  app.advance(15);
  assert.equal((await app.request(path)).body.status, 'expired');
  assert.equal((await app.request('/api/checkouts', { method: 'POST', body: selection })).status, 201);
});

test('Tylko zweryfikowana pełna przedpłata potwierdza rezerwację i wysyła jedno potwierdzenie', async (t) => {
  const app = await startTestApp(t);
  const { path, selection } = await startHold(app);
  const { body: checkout } = await app.request(path + '/payment', { method: 'POST', body: renter });
  const paymentId = checkout.paymentUrl.split('/').at(-1);
  const notify = () => app.request('/api/payment-notifications', {
    method: 'POST', body: { paymentId, amount: 2000, status: 'paid' },
  });
  const simulate = (amount) => app.request('/api/simulator/payments/' + paymentId + '/pay', {
    method: 'POST', body: { amount },
  });
  const staff = () => app.request('/api/staff/bookings', { headers: { Authorization: staffAuthorization } });

  assert.equal((await notify()).body.status, 'payment');
  assert.equal((await simulate(1000)).status, 200);
  assert.equal((await notify()).body.status, 'payment');
  assert.deepEqual((await staff()).body, []);
  assert.equal((await app.request(path + '/confirmation')).status, 404);

  assert.equal((await simulate(2000)).status, 200);
  const results = await Promise.all([notify(), notify(), notify()]);
  const [booking] = (await staff()).body;
  assert.ok(booking);
  for (const result of results) {
    assert.equal(result.body.status, 'confirmed');
    assert.equal(result.body.bookingId, booking.id);
  }
  assert.equal(booking.email, renter.email);
  assert.equal(booking.phone, renter.phone);
  assert.equal(booking.riderHeight, 176);
  assert.equal(booking.total, 2000);
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.pickupAt, '2027-01-15T14:00:00.000Z');
  assert.equal(booking.returnAt, '2027-01-15T15:00:00.000Z');

  const confirmation = await app.request(path + '/confirmation');
  assert.equal(confirmation.body.to, renter.email);
  assert.match(confirmation.body.subject, /Potwierdzenie rezerwacji/);
  assert.equal(confirmation.body.bookingId, booking.id);
  assert.equal((await staff()).body.length, 1);
  assert.equal((await app.request('/api/staff/bookings')).status, 401);
  app.advance(16);
  assert.equal((await app.request(path)).body.status, 'confirmed');
  assert.equal((await app.request('/api/checkouts', { method: 'POST', body: selection })).status, 409);
});
