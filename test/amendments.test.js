import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const owner = { Authorization: staffAuthorization };
const shopId = 'warszawa-demo';
const tour = 'rower-turystyczny';
const child = 'rower-dzieciecy';
const helmet = 'kask';
const shop = '/api/staff/shops/' + shopId;
const pickupAt = '2027-01-16T09:00:00.000Z';
const returnAt = '2027-01-19T11:00:00.000Z';
const post = (app, path, body = {}, headers) => app.request(path, { method: 'POST', body, headers });

async function configure(app, weeklyHours, rates) {
  assert.equal((await post(app, shop + '/settings', { maxRentalMinutes: 4_500, weeklyHours }, owner)).status, 200);
  assert.equal((await post(app, shop + '/catalog', { id: tour, kind: 'bike', name: 'Rower turystyczny', ...rates }, owner)).status, 200);
}

async function book(app, items, start = pickupAt, end = returnAt) {
  const held = await post(app, '/api/checkouts', { shopId, slotId: start, returnAt: end, items });
  assert.equal(held.status, 201);
  const checkout = '/api/checkouts/' + held.body.id;
  const bikeCount = held.body.items.filter(({ kind }) => kind === 'bike').reduce((sum, { quantity }) => sum + quantity, 0);
  const payment = await post(app, checkout + '/payment', {
    email: 'renter@example.test', phone: '+48 500 123 456', riderHeights: Array(bikeCount).fill(176), acceptedTerms: true,
  });
  assert.equal(payment.status, 200);
  const paymentId = payment.body.paymentUrl.split('/').at(-1);
  assert.equal((await post(app, '/api/simulator/payments/' + paymentId + '/pay')).body.status, 'paid');
  const confirmation = await post(app, '/api/payment-notifications', { paymentId });
  assert.equal(confirmation.body.status, 'confirmed');
  return { ...confirmation.body, checkout, paymentId };
}

const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const allDay = Object.fromEntries(days.map((day) => [day, [['00:00', '24:00']]]));
const twoBikes = [{ itemId: tour, quantity: 1 }, { itemId: child, quantity: 1 }];
const amendment = (id) => shop + '/bookings/' + id + '/amendment';
const historyPath = (id) => '/api/staff/bookings/' + id + '/refunds';

test('Zmiana 74-godzinnej rezerwacji zwraca 240 PLN za zdjęty rower i od razu zwalnia jego dostępność', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-16T08:00:00.000Z', allowSimulatedRefunds: true });
  await configure(app, allDay, { hourlyRate: 2_000, dayRate: null, fullDayRate: 10_000 });
  const booking = await book(app, twoBikes);
  const path = amendment(booking.bookingId);
  const removedItems = [{ itemId: tour, quantity: 1 }];
  app.advance(60);
  const review = await post(app, path + '/preview', { removedItems }, owner);
  assert.equal(review.status, 200);
  assert.equal(review.body.eligibleCharges.reduce((total, charge) => total + charge.amount, 0), 24_000);

  const freedPeriod = { shopId, slotId: '2027-01-16T09:30:00.000Z', returnAt: '2027-01-19T10:30:00.000Z', items: removedItems };
  assert.equal((await post(app, '/api/checkouts', freedPeriod)).status, 409);
  const input = {
    removedItems, charges: review.body.eligibleCharges.map(({ id, quantity }) => ({ id, quantity })),
    revision: review.body.revision, expectedRefund: 24_000, renterAgreed: true,
  };
  assert.equal((await post(app, path, { ...input, expectedRefund: 25_000 }, owner)).status, 409);
  const [result, retry] = await Promise.all([post(app, path, input, owner), post(app, path, input, owner)]);
  assert.equal(result.status, 200);
  assert.deepEqual(retry, result);
  assert.equal(result.body.refund.amount, 24_000);
  assert.equal(result.body.refund.status, 'pending');
  assert.equal(result.body.approvedBy, 'obsluga');
  assert.equal((await post(app, '/api/checkouts', freedPeriod)).status, 201);

  const simulator = '/api/simulator/refunds/' + result.body.refund.id;
  assert.equal((await post(app, simulator, { status: 'completed' })).body.status, 'completed');
  assert.equal((await post(app, simulator, { status: 'completed' })).status, 200);
  assert.equal((await post(app, simulator, { status: 'failed' })).status, 409);
  const { body: history } = await app.request(historyPath(booking.bookingId), { headers: owner });
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].details.charges.reduce((total, charge) => total + charge.amount, 0), 24_000);
});

test('Zmiana rozlicza część opłaty po 24 godzinach i pokazuje odrzucony zwrot wybranych opłat', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-16T08:00:00.000Z', allowSimulatedRefunds: true });
  await configure(app, allDay, { hourlyRate: 2_000, dayRate: null, fullDayRate: null });
  const booking = await book(app, [...twoBikes, { itemId: helmet, quantity: 2 }], pickupAt, '2027-01-17T10:00:00.000Z');
  const path = amendment(booking.bookingId);
  const removedItems = [{ itemId: tour, quantity: 1 }, { itemId: helmet, quantity: 2 }];
  app.advance(60);
  const { body: review } = await post(app, path + '/preview', { removedItems }, owner);
  const bikeCharge = review.eligibleCharges.find(({ itemId }) => itemId === tour);
  const helmetCharge = review.eligibleCharges.find(({ itemId }) => itemId === helmet);
  assert.equal(bikeCharge.originalAmount, 50_000);
  assert.equal(bikeCharge.amount, 2_000);
  assert.equal(helmetCharge.amount, 1_000);

  const input = { removedItems, charges: [{ id: helmetCharge.id, quantity: 1 }], revision: review.revision, expectedRefund: 500, renterAgreed: true };
  const { body: approved } = await post(app, path, input, owner);
  assert.equal(approved.refund.amount, 500);
  assert.deepEqual(approved.charges.map(({ itemId, quantity }) => ({ itemId, quantity })), [{ itemId: helmet, quantity: 1 }]);
  assert.equal((await post(app, '/api/simulator/refunds/' + approved.refund.id, { status: 'failed' })).body.status, 'failed');
  assert.equal((await post(app, path, input, owner)).body.refund.status, 'failed');
  const { body: [updated] } = await app.request(shop + '/bookings', { headers: owner });
  assert.equal(updated.amendments[0].refund.status, 'failed');
  assert.deepEqual(updated.allocatedItems.map(({ itemId }) => itemId), [child]);
  assert.equal(updated.partnerCancellationRefund, updated.total);
  const cancellation = await post(app, '/api/staff/bookings/' + booking.bookingId + '/cancel', {}, owner);
  assert.equal(cancellation.body.cancellationRefund, updated.total);
  const { body: history } = await app.request(historyPath(booking.bookingId), { headers: owner });
  assert.deepEqual(history.map(({ status, amount }) => [status, amount]), [['failed', 500], ['completed', updated.total]]);
});

test('Tylko obsługa z uprawnieniem do zwrotów w punkcie zatwierdza zmianę przy odbiorze', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-16T08:00:00.000Z' });
  await configure(app, allDay, { hourlyRate: 2_000, dayRate: null, fullDayRate: 10_000 });
  const worker = { Authorization: 'Basic ' + Buffer.from('zmiana:syntetyczne-haslo').toString('base64') };
  assert.equal((await post(app, '/api/staff/members', { username: 'zmiana', password: 'syntetyczne-haslo' }, owner)).status, 201);
  const assignments = '/api/staff/members/zmiana/assignments';
  assert.equal((await post(app, assignments, { shopId, canRefund: false }, owner)).status, 200);
  const booking = await book(app, twoBikes);
  app.advance(60);
  const path = amendment(booking.bookingId);
  const removedItems = [{ itemId: tour, quantity: 1 }];
  assert.equal((await post(app, path + '/preview', { removedItems }, worker)).status, 403);
  assert.equal((await post(app, path, { removedItems }, worker)).status, 403);
  assert.equal((await post(app, assignments, { shopId, canRefund: true }, owner)).status, 200);
  const { body: review } = await post(app, path + '/preview', { removedItems }, worker);
  const input = { removedItems, charges: [], revision: review.revision, expectedRefund: 0, renterAgreed: true };
  const approved = await post(app, path, input, worker);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approvedBy, 'zmiana');
});

test('Przed odbiorem obsługa potwierdza dostępność i uzgodnioną cenę przed zmianą terminu', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-16T08:00:00.000Z' });
  await configure(app, allDay, { hourlyRate: 2_000, dayRate: null, fullDayRate: null });
  const initialReturn = '2027-01-16T10:00:00.000Z';
  const items = [{ itemId: tour, quantity: 1 }];
  const booking = await book(app, items, pickupAt, initialReturn);
  await book(app, items, '2027-01-16T10:30:00.000Z', '2027-01-16T11:30:00.000Z');
  const path = shop + '/bookings/' + booking.bookingId + '/change';
  const proposed = { items, pickupAt: '2027-01-16T11:30:00.000Z', returnAt: '2027-01-16T12:30:00.000Z' };
  assert.equal((await post(app, path + '/preview', { ...proposed, pickupAt: '2027-01-16T11:00:00.000Z' }, owner)).status, 409);
  const adjusted = { ...proposed, returnAt: '2027-01-16T13:30:00.000Z' };
  const adjustedPreview = await post(app, path + '/preview', adjusted, owner);
  assert.equal(adjustedPreview.body.priceDifference, 2_000);
  assert.equal(adjustedPreview.body.canApprove, false);
  assert.equal((await post(app, path, { ...adjusted, ...adjustedPreview.body, renterAgreed: true }, owner)).status, 409);

  const preview = await post(app, path + '/preview', proposed, owner);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.priceDifference, 0);
  const approval = { ...proposed, revision: preview.body.revision, quoteVersion: preview.body.quoteVersion };
  assert.equal((await post(app, path, approval, owner)).status, 400);
  assert.equal((await post(app, path, { ...approval, renterAgreed: true }, owner)).status, 200);
  assert.equal((await post(app, '/api/checkouts', { shopId, slotId: pickupAt, returnAt: initialReturn, items })).status, 201);
  assert.equal((await post(app, '/api/checkouts', { shopId, slotId: proposed.pickupAt, returnAt: proposed.returnAt, items })).status, 409);

  const { body: confirmation } = await app.request(booking.checkout + '/confirmation');
  const { body: renterView } = await app.request('/api' + confirmation.bookingUrl.replace('/booking/', '/bookings/'));
  assert.equal(renterView.id, booking.bookingId);
  assert.equal(renterView.pickupAt, proposed.pickupAt);
  assert.equal(renterView.returnAt, proposed.returnAt);
  assert.equal(renterView.total, 2_000);
});

test('Po zamianie roweru przy odbiorze zwrot nadal odnosi się do pierwotnie opłaconej kategorii', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-16T08:00:00.000Z' });
  await configure(app, allDay, { hourlyRate: 2_000, dayRate: null, fullDayRate: 10_000 });
  const booking = await book(app, twoBikes);
  assert.equal((await post(app, shop + '/stock', { itemId: tour, quantity: 0 }, owner)).status, 200);
  const base = shop + '/bookings/' + booking.bookingId;
  assert.equal((await post(app, base + '/substitute', { fromItemId: tour, toItemId: child, quantity: 1, revision: 0 }, owner)).status, 200);
  app.advance(60);
  const removedItems = [{ itemId: tour, quantity: 1 }];
  const review = await post(app, base + '/amendment/preview', { removedItems }, owner);
  assert.equal(review.status, 200);
  const { eligibleCharges, revision, substitutionRevision } = review.body;
  assert.deepEqual(new Set(eligibleCharges.map(({ itemId }) => itemId)), new Set([tour]));
  const charges = eligibleCharges.map(({ id, quantity }) => ({ id, quantity }));
  const approval = await post(app, base + '/amendment', {
    removedItems, charges, revision, substitutionRevision, expectedRefund: 24_000, renterAgreed: true,
  }, owner);
  assert.equal(approval.status, 200);
  assert.equal(approval.body.refund.amount, 24_000);
  const { body: [updated] } = await app.request(shop + '/bookings', { headers: owner });
  assert.deepEqual(updated.allocatedItems.map(({ itemId, quantity }) => [itemId, quantity]), [[child, 1]]);
});

test('Anulowanie przez Partnera uzupełnia pełny zwrot po odrzuceniu oczekującego zwrotu przy odbiorze', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-16T08:00:00.000Z', allowSimulatedRefunds: true });
  await configure(app, allDay, { hourlyRate: 2_000, dayRate: null, fullDayRate: 10_000 });
  const booking = await book(app, twoBikes);
  app.advance(60);
  const path = amendment(booking.bookingId);
  const removedItems = [{ itemId: tour, quantity: 1 }];
  const { body: review } = await post(app, path + '/preview', { removedItems }, owner);
  const approval = await post(app, path, {
    removedItems, charges: review.eligibleCharges.map(({ id, quantity }) => ({ id, quantity })),
    revision: review.revision, expectedRefund: 24_000, renterAgreed: true,
  }, owner);
  assert.equal(approval.status, 200);
  assert.equal(approval.body.refund.status, 'pending');
  const cancelPath = '/api/staff/bookings/' + booking.bookingId + '/cancel';
  const initial = await post(app, cancelPath, {}, owner);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.cancellationRefund, initial.body.total - 24_000);

  const resolvePath = '/api/simulator/refunds/' + approval.body.refund.id;
  const resolutions = await Promise.all([
    post(app, resolvePath, { status: 'failed' }), post(app, resolvePath, { status: 'failed' }),
  ]);
  assert.deepEqual(resolutions.map(({ body }) => body.status), ['failed', 'failed']);

  const { body: history } = await app.request(historyPath(booking.bookingId), { headers: owner });
  assert.deepEqual(history.map(({ reason, status, amount }) => [reason, status, amount]), [
    ['pickup-amendment', 'failed', 24_000],
    ['partner-cancellation', 'completed', initial.body.total - 24_000],
    ['partner-cancellation', 'completed', 24_000],
  ]);
  const completed = history.filter(({ status }) => status === 'completed');
  assert.equal(completed.reduce((sum, entry) => sum + entry.platformDebit, 0), completed[0].originalCommission);
  assert.equal((await post(app, cancelPath, {}, owner)).body.cancellationRefund, initial.body.total);
  const { body: confirmation } = await app.request(booking.checkout + '/confirmation');
  const { body: renterView } = await app.request('/api' + confirmation.bookingUrl.replace('/booking/', '/bookings/'));
  assert.equal(renterView.cancellationRefund, initial.body.total);
});
