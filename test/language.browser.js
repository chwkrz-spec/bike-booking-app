import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { staffAuthorization, startTestApp } from './support.js';

const shopId = 'warszawa-demo';
const pickup = '2027-01-15T14:00:00.000Z';
const returned = '2027-01-15T15:30:00.000Z';
const terms = 'Please return the bikes before the shop closes.';
const settings = '/api/staff/shops/' + shopId + '/renter-copy';

async function publish(app) {
  const result = await app.request(settings, {
    method: 'POST', headers: { authorization: staffAuthorization },
    body: { nameEn: 'Warsaw bike shop', descriptionEn: 'Ride by the river.', termsEn: terms },
  });
  assert.equal(result.status, 200);
}

async function checkBooking(app, renter, result) {
  await renter.getByRole('link', { name: 'View booking' }).click();
  await renter.getByRole('heading', { name: 'Your booking' }).waitFor();
  assert.equal(await renter.locator('html').getAttribute('lang'), 'en');
  await renter.getByText('Accepted rental terms').click();
  await renter.getByText(terms, { exact: false }).waitFor();
  await renter.getByRole('button', { name: 'Cancel booking' }).click();
  await renter.getByText('Booking cancelled', { exact: true }).waitFor();
  const privateView = await app.request('/api' + new URL(renter.url()).pathname);
  assert.equal(privateView.body.language, 'en');
  assert.equal(privateView.body.status, 'cancelled');
  assert.equal(result.status, 200);
  assert.equal(result.body.subject, 'Booking confirmation');
  assert.match(result.body.content, /Booking details and cancellation/);
}

test('Widget booking keeps English through private resume, simulated payment, confirmation, and cancellation', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const original = await browser.newPage();
  original.setDefaultTimeout(5000);
  await original.goto(app.origin);
  assert.equal(await original.getByLabel('Język / Language').isVisible(), false);

  await publish(app);
  await original.reload();
  await original.getByLabel('Język / Language').selectOption('en');
  await original.getByText('Ride by the river.').waitFor();
  await original.getByLabel('Pickup time').selectOption(pickup);
  await original.getByLabel('Return time').selectOption(returned);
  await original.getByRole('button', { name: 'Confirm selection' }).click();
  await original.getByText('Rental terms', { exact: true }).click();
  await original.getByText(terms, { exact: false }).waitFor();
  await original.getByLabel('Email address').fill('english-widget@example.test');
  await original.getByLabel('Phone number').fill('+48 500 123 456');

  const [sent] = await Promise.all([
    original.waitForResponse(/\/api\/checkouts\/[^/]+\/resume-link$/),
    original.getByRole('button', { name: 'Email me a link to finish booking' }).click(),
  ]);
  const message = await sent.json();
  assert.equal(message.subject, 'Finish your bike booking');
  assert.match(message.content, /24 hours/);
  await original.close();

  app.advance(15);
  const renter = await browser.newPage();
  renter.setDefaultTimeout(5000);
  await renter.goto(app.origin + message.resumeUrl);
  await renter.getByRole('button', { name: 'Confirm current selection' }).click();
  assert.equal(await renter.getByLabel('Email address').inputValue(), 'english-widget@example.test');
  await renter.getByLabel('Rider height (cm)', { exact: true }).fill('178');
  await renter.getByLabel('I accept the rental terms').check();
  const [popup] = await Promise.all([
    renter.waitForEvent('popup'), renter.getByRole('button', { name: 'Pay', exact: true }).click(),
  ]);
  await popup.getByRole('button', { name: 'Simulate payment' }).click();
  const [confirmation] = await Promise.all([
    renter.waitForResponse(/\/api\/checkouts\/[^/]+\/confirmation$/),
    renter.getByRole('link', { name: 'View booking' }).waitFor(),
  ]);
  await checkBooking(app, renter, { status: confirmation.status(), body: await confirmation.json() });
});

test('Polish staff panel publishes English terms and sends an English checkout through cancellation', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const staff = await browser.newPage({ httpCredentials: { username: 'obsluga', password: 'showcase-credentials' } });
  staff.setDefaultTimeout(5000);
  await staff.goto(app.origin + '/staff');
  await staff.getByRole('heading', { name: 'Rezerwacje punktu' }).waitFor();
  await staff.getByLabel('Warunki najmu po angielsku').fill(terms);
  await staff.getByRole('button', { name: 'Zapisz treści dla klientów' }).click();
  await staff.getByText('Zapisano treści dla klientów.').waitFor();
  const form = staff.getByRole('region', { name: 'Rezerwacja przygotowana przez obsługę' });
  await form.getByLabel('Termin odbioru').selectOption(pickup);
  await form.getByLabel('Termin zwrotu').selectOption(returned);
  await form.getByLabel('Rower turystyczny').fill('1');
  await form.getByLabel('Adres e-mail klienta').fill('english-staff@example.test');
  await form.getByLabel('Język wiadomości i płatności').selectOption('en');
  await form.getByRole('button', { name: 'Wyślij link do płatności' }).click();
  await form.getByText('Pay to confirm your bike booking', { exact: false }).waitFor();
  const link = form.getByRole('link', { name: 'Otwórz prywatny link' });
  const path = await link.getAttribute('href');
  const renter = await browser.newPage();
  renter.setDefaultTimeout(5000);
  await renter.goto(app.origin + path + '?language=pl');
  await renter.getByText(terms, { exact: false }).waitFor();
  await renter.getByLabel('Height of rider 1 (cm)').fill('178');
  await renter.getByLabel('I accept the rental terms').check();
  await renter.getByRole('button', { name: 'Pay', exact: true }).click();
  await renter.getByRole('button', { name: 'Simulate payment' }).click();
  const [confirmation] = await Promise.all([
    renter.waitForResponse(/\/api\/checkouts\/[^/]+\/confirmation$/),
    renter.getByRole('link', { name: 'Return to booking' }).click(),
  ]);
  await checkBooking(app, renter, { status: confirmation.status(), body: await confirmation.json() });
});
