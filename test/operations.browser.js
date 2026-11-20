import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { staffAuthorization, startTestApp } from './support.js';

test('Panel pokazuje opóźnienie, pozwala odnotować zamiennik i zamknąć zwrot sprzętu', async (t) => {
  const app = await startTestApp(t);
  const shopId = 'warszawa-demo';
  const categoryId = 'rower-turystyczny';
  const post = (path, body, headers) => app.request(path, { method: 'POST', body, headers });
  async function book(slotId, returnAt) {
    const { body: hold } = await post('/api/checkouts', { shopId, categoryId, slotId, returnAt });
    const { body: session } = await post('/api/checkouts/' + hold.id + '/payment', {
      email: 'renter@example.test', phone: '+48 500 123 456', riderHeight: 176, acceptedTerms: true,
    });
    const paymentId = session.paymentUrl.split('/').at(-1);
    await post('/api/simulator/payments/' + paymentId + '/pay', {});
    return (await post('/api/payment-notifications', { paymentId })).body.bookingId;
  }

  const out = await book('2027-01-15T14:00:00.000Z', '2027-01-15T15:00:00.000Z');
  const affected = await book('2027-01-15T16:00:00.000Z', '2027-01-15T16:30:00.000Z');
  app.advance(57);
  assert.equal((await post('/api/staff/shops/' + shopId + '/bookings/' + out + '/pickup', {
    items: [{ itemId: categoryId, units: ['TOUR-1'] }],
  }, { Authorization: staffAuthorization })).status, 200);
  app.advance(60);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ httpCredentials: { username: 'obsluga', password: 'showcase-credentials' } });
  page.setDefaultTimeout(3000);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(app.origin + '/staff');

  const issued = page.getByRole('row').filter({ hasText: out });
  const upcoming = page.getByRole('row').filter({ hasText: affected });
  await issued.getByText('Sprzęt po terminie zwrotu').waitFor();
  await upcoming.getByText(/Zagrożona rezerwacja/).waitFor();
  await upcoming.getByText('Uzgodnij zamiennik', { exact: true }).click();
  await upcoming.getByLabel('Zamiennik').selectOption('rower-dzieciecy');
  await upcoming.getByRole('button', { name: 'Zapisz uzgodniony zamiennik' }).click();
  await upcoming.getByText('Rower dziecięcy × 1').waitFor();
  assert.equal(await upcoming.getByText(/Zagrożona rezerwacja/).count(), 0);
  await issued.getByRole('button', { name: 'Potwierdź zwrot sprzętu' }).click();
  await issued.getByText(/Sprzęt zwrócony/).waitFor();
  assert.equal(await issued.getByText('Sprzęt po terminie zwrotu').count(), 0);
});
