import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Panel pokazuje wybraną kwotę przed zatwierdzeniem i odrzucony zwrot po zmianie przy odbiorze', async (t) => {
  const app = await startTestApp(t, { allowSimulatedRefunds: true });
  const post = (path, body = {}) => app.request(path, { method: 'POST', body });
  const shopId = 'warszawa-demo';
  const { body: hold } = await post('/api/checkouts', {
    shopId, slotId: '2027-01-15T14:00:00.000Z', returnAt: '2027-01-15T15:00:00.000Z',
    items: [{ itemId: 'rower-turystyczny', quantity: 1 }, { itemId: 'kask', quantity: 1 }],
  });
  const { body: payment } = await post('/api/checkouts/' + hold.id + '/payment', {
    email: 'renter@example.test', phone: '+48 500 123 456', riderHeights: [176], acceptedTerms: true,
  });
  const paymentId = payment.paymentUrl.split('/').at(-1);
  await post('/api/simulator/payments/' + paymentId + '/pay');
  const { body: booking } = await post('/api/payment-notifications', { paymentId });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ httpCredentials: { username: 'obsluga', password: 'showcase-credentials' } });
  page.setDefaultTimeout(3000);
  app.advance(57);
  await page.goto(app.origin + '/staff');

  const row = page.getByRole('row').filter({ hasText: booking.bookingId });
  await row.getByText('Zmień skład przy odbiorze', { exact: true }).click();
  await row.getByLabel('Zdejmij – Kask', { exact: true }).fill('1');
  await row.getByRole('button', { name: 'Sprawdź opłaty' }).click();
  await row.getByLabel('Kask · 5,00 PLN/szt.').fill('1');
  await row.getByText('Kwota zwrotu: 5,00 PLN').waitFor();
  await row.getByLabel('Klient zaakceptował zmianę').check();
  const request = page.waitForResponse((response) => response.url().endsWith('/amendment'));
  await row.getByRole('button', { name: 'Zatwierdź zmianę przy odbiorze' }).click();
  const { refund } = await (await request).json();
  assert.equal(refund.status, 'pending');
  await row.getByText('Zwrot oczekuje na potwierdzenie').waitFor();
  await post('/api/simulator/refunds/' + refund.id, { status: 'failed' });
  await page.getByRole('button', { name: 'Odśwież rezerwacje' }).click();
  await row.getByText('Zwrot odrzucony · wymaga wyjaśnienia').waitFor();
  assert.equal(await row.getByText('Kask × 1', { exact: true }).count(), 0);
});
