import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Gość kończy rezerwację w osobnym oknie symulatora, a obsługa widzi potwierdzony najem', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'pl-PL' });
  await page.goto(app.origin);
  await page.getByRole('heading', { name: 'Zarezerwuj rower' }).waitFor();
  await page.getByText('Rowerowy Punkt Testowy sp. z o.o.', { exact: true }).waitFor();
  await page.getByText('ul. Przykładowa 1, 00-001 Warszawa', { exact: true }).waitFor();
  await page.getByText('NIP 0000000000', { exact: true }).waitFor();
  const slot = page.getByLabel('Termin odbioru');
  await slot.locator('option').first().waitFor({ state: 'attached' });
  await slot.selectOption({ index: 0 });
  assert.match(await page.getByTestId('total').textContent(), /20,00\sPLN/);
  await page.getByRole('button', { name: 'Potwierdź wybór' }).click();

  const deadline = page.locator('time#hold-deadline');
  await deadline.waitFor();
  assert.equal(await deadline.getAttribute('datetime'), '2027-01-15T13:18:00.000Z');
  await page.reload();
  await deadline.waitFor();
  assert.equal(await deadline.getAttribute('datetime'), '2027-01-15T13:18:00.000Z');

  await page.getByLabel('Adres e-mail').fill('pilot@example.test');
  await page.getByLabel('Numer telefonu').fill('+48 500 123 456');
  await page.getByLabel('Wzrost uczestnika (cm)').fill('176');
  await page.getByLabel('Akceptuję warunki najmu').check();
  app.advance(8);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: 'Zapłać' }).click(),
  ]);
  await popup.getByRole('heading', { name: 'Symulator płatności' }).waitFor();
  const paymentDeadline = popup.locator('time#payment-deadline');
  await paymentDeadline.waitFor();
  assert.equal(await paymentDeadline.getAttribute('datetime'), '2027-01-15T13:26:00.000Z');
  await popup.reload();
  await paymentDeadline.waitFor();
  assert.equal(await paymentDeadline.getAttribute('datetime'), '2027-01-15T13:26:00.000Z');
  await popup.getByRole('button', { name: 'Zasymuluj płatność' }).click();
  await popup.getByText('Płatność zweryfikowana', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Rezerwacja potwierdzona' }).waitFor();
  await page.getByText('pilot@example.test', { exact: true }).waitFor();

  const staff = await browser.newPage({
    httpCredentials: { username: 'obsluga', password: 'showcase-credentials' },
  });
  await staff.goto(app.origin + '/staff');
  const row = staff.getByRole('row').filter({ hasText: 'pilot@example.test' });
  await row.waitFor();
  assert.match(await row.textContent(), /176 cm/);
  assert.match(await row.textContent(), /Potwierdzona/);
});

test('Odświeżenie po przerwanym połączeniu odzyskuje ten sam termin rozpoczętej blokady', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'pl-PL' });
  await page.goto(app.origin);
  await page.getByLabel('Termin odbioru').waitFor();

  let firstDeadline;
  await page.route('**/api/checkouts', async (route) => {
    const response = await route.fetch();
    firstDeadline = (await response.json()).expiresAt;
    await route.abort('failed');
  }, { times: 1 });
  const failed = page.waitForEvent('requestfailed', (request) => request.url() === app.origin + '/api/checkouts');
  await page.getByRole('button', { name: 'Potwierdź wybór' }).click();
  await failed;
  app.advance(4);

  await page.reload();
  const deadline = page.locator('time#hold-deadline');
  await deadline.waitFor({ timeout: 3000 });
  assert.equal(firstDeadline, '2027-01-15T13:18:00.000Z');
  assert.equal(await deadline.getAttribute('datetime'), firstDeadline);
});

test('Okno płatności pokazuje informację o pełnym zwrocie po spóźnionej weryfikacji', async (t) => {
  const app = await startTestApp(t);
  const { body: offer } = await app.request('/api/offer');
  const selection = app.selection(offer);
  const { body: hold } = await app.request('/api/checkouts', { method: 'POST', body: selection });
  const { body: payment } = await app.request('/api/checkouts/' + hold.id + '/payment', {
    method: 'POST',
    body: { email: 'pilot@example.test', phone: '+48 500 123 456', riderHeight: 176, acceptedTerms: true },
  });
  const paymentId = payment.paymentUrl.split('/').at(-1);
  await app.request('/api/simulator/payments/' + paymentId + '/pay', { method: 'POST', body: {} });
  app.advance(15);
  const competingHold = await app.request('/api/checkouts', { method: 'POST', body: selection });
  assert.equal(competingHold.status, 201);
  await app.request('/api/payment-notifications', { method: 'POST', body: { paymentId } });

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'pl-PL' });
  await page.goto(app.origin + payment.paymentUrl);
  await page.getByRole('status').filter({ hasText: 'Zleciliśmy pełny zwrot płatności.' }).waitFor({ timeout: 3000 });
  assert.equal(await page.getByRole('button', { name: 'Zasymuluj płatność' }).isVisible(), false);
});
