import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { staffAuthorization, startTestApp } from './support.js';

test('Właściciel otwiera wyniki i filtruje po punkcie oraz po dacie', async (t) => {
  const app = await startTestApp(t);
  const headers = { Authorization: staffAuthorization };
  const post = (path, body, headers) => app.request(path, { method: 'POST', body, headers });
  assert.equal((await post('/api/staff/shops', { name: 'Nowy punkt' }, headers)).status, 201);
  assert.equal((await post('/api/staff/members', { username: 'mechanik', password: 'synthetic-password' }, headers)).status, 201);

  const { body: hold } = await post('/api/checkouts', {
    shopId: 'warszawa-demo', categoryId: 'rower-turystyczny',
    slotId: '2027-01-15T14:00:00.000Z', returnAt: '2027-01-15T15:00:00.000Z',
  });
  const { body: payment } = await post('/api/checkouts/' + hold.id + '/payment', {
    email: 'renter@example.test', phone: '+48 500 123 456', riderHeight: 176, acceptedTerms: true,
  });
  const paymentId = payment.paymentUrl.split('/').at(-1);
  await post('/api/simulator/payments/' + paymentId + '/pay', {});
  assert.equal((await post('/api/payment-notifications', { paymentId })).body.status, 'confirmed');

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const owner = await browser.newPage({ httpCredentials: { username: 'obsluga', password: 'showcase-credentials' } });
  owner.setDefaultTimeout(3000);
  await owner.goto(app.origin + '/staff');
  await owner.getByRole('link', { name: 'Wyniki Partnera' }).click();
  await owner.getByRole('heading', { name: 'Wyniki Partnera' }).waitFor();
  await owner.getByText(/20,00\sPLN/).waitFor();
  const status = owner.getByRole('row', { name: /^Potwierdzone / });
  assert.match(await status.innerText(), /1\s+0\s+1/);
  await owner.getByRole('region', { name: 'Nadchodzące odbiory' }).getByText('Rower turystyczny × 1').waitFor();
  await owner.getByLabel('Punkt', { exact: true }).selectOption({ label: 'Nowy punkt' });
  await owner.getByRole('button', { name: 'Pokaż wyniki' }).click();
  await owner.getByText('Brak odbiorów w wybranym zakresie.').waitFor();

  await owner.getByLabel('Punkt', { exact: true }).selectOption('');
  await owner.getByLabel('Od daty').fill('2027-01-16');
  await Promise.all([
    owner.waitForResponse((response) => response.url().includes('from=2027-01-16') && response.ok()),
    owner.getByRole('button', { name: 'Pokaż wyniki' }).click(),
  ]);
  await status.getByRole('cell', { name: '0', exact: true }).last().waitFor();
  assert.match(await status.innerText(), /0\s+0\s+0/);
  await owner.getByLabel('Od daty').fill('2027-01-15');
  await owner.getByRole('button', { name: 'Pokaż wyniki' }).click();
  await owner.getByRole('region', { name: 'Nadchodzące odbiory' }).getByText('Rower turystyczny × 1').waitFor();

  const staff = await browser.newPage({ httpCredentials: { username: 'mechanik', password: 'synthetic-password' } });
  await staff.goto(app.origin + '/staff');
  await staff.getByText('Brak przypisanych punktów.').waitFor();
  assert.equal(await staff.getByRole('link', { name: 'Wyniki Partnera' }).count(), 0);
  assert.equal((await staff.goto(app.origin + '/staff/owner-dashboard')).status(), 403);
});
