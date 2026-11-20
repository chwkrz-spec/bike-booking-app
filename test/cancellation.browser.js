import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Gość widzi i anuluje całą rezerwację przez prywatny link z potwierdzenia', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const { body: hold } = await app.request('/api/checkouts', {
    method: 'POST', body: app.selection(offer),
  });
  const checkoutPath = '/api/checkouts/' + hold.id;
  const { body: payment } = await app.request(checkoutPath + '/payment', {
    method: 'POST',
    body: {
      email: 'renter@example.test', phone: '+48 500 123 456',
      riderHeight: 176, acceptedTerms: true, termsVersion: hold.termsVersion,
    },
  });
  const paymentId = payment.paymentUrl.split('/').at(-1);
  await app.request('/api/simulator/payments/' + paymentId + '/pay', { method: 'POST', body: {} });
  await app.request('/api/payment-notifications', { method: 'POST', body: { paymentId } });
  const { body: confirmation } = await app.request(checkoutPath + '/confirmation');

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'pl-PL' });
  await page.goto(app.origin + confirmation.bookingUrl);
  await page.getByText('Rezerwacja potwierdzona', { exact: true }).waitFor();
  assert.match(await page.getByTestId('cancellation-refund').textContent(), /10,00\sPLN/);
  await page.getByRole('button', { name: 'Anuluj całą rezerwację' }).click();
  await page.getByText('Rezerwacja anulowana', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Rezerwacja anulowana', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Anuluj całą rezerwację' }).isVisible(), false);
});
