import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Obsługa ustawia zapas i przydziela rowery przy odbiorze koszyka z akcesoriami', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const staff = await browser.newPage({
    httpCredentials: { username: 'obsluga', password: 'showcase-credentials' },
  });
  await staff.goto(app.origin + '/staff');
  const stock = staff.getByLabel('Kask', { exact: true });
  await stock.fill('1', { timeout: 5000 });
  await stock.locator('..').getByRole('button', { name: 'Zapisz ilość' }).click();
  await staff.getByRole('status').filter({ hasText: 'Zapisano ilość w puli online.' }).waitFor();

  const page = await browser.newPage({ locale: 'pl-PL' });
  await page.goto(app.origin);
  await page.getByLabel('Rower dziecięcy', { exact: true }).fill('2');
  const accessory = page.getByLabel('Kask', { exact: true });
  assert.equal(await accessory.getAttribute('max'), '1');
  await accessory.fill('1');
  assert.match(await page.getByTestId('total').textContent(), /55,00\sPLN/);
  await page.getByRole('button', { name: 'Potwierdź wybór' }).click();

  await page.getByLabel('Wzrost uczestnika — Rower turystyczny 1 (cm)').fill('176');
  await page.getByLabel('Wzrost uczestnika — Rower dziecięcy 1 (cm)').fill('119');
  await page.reload();
  const second = page.getByLabel('Wzrost uczestnika — Rower dziecięcy 2 (cm)');
  await second.waitFor();
  assert.equal(await page.getByLabel('Wzrost uczestnika — Rower dziecięcy 1 (cm)').inputValue(), '119');
  assert.equal(await second.inputValue(), '');
  await second.fill('131');
  await page.getByLabel('Adres e-mail').fill('koszyk@example.test');
  await page.getByLabel('Numer telefonu').fill('+48 500 123 456');
  await page.getByLabel('Akceptuję warunki najmu').check();
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: 'Zapłać' }).click(),
  ]);
  await popup.getByRole('button', { name: 'Zasymuluj płatność' }).click();
  await page.getByRole('heading', { name: 'Rezerwacja potwierdzona' }).waitFor();

  app.advance(57);
  await staff.reload();
  const row = staff.getByRole('row').filter({ hasText: 'koszyk@example.test' });
  await row.waitFor();
  assert.match(await row.textContent(), /Kask.*119 cm.*131 cm/);
  await row.getByText('Przydziel rowery').click();
  await row.getByLabel('Rower turystyczny 1').fill('T-01');
  await row.getByLabel('Rower dziecięcy 1').fill('D-01');
  await row.getByLabel('Rower dziecięcy 2').fill('D-02');
  await row.getByRole('button', { name: 'Zapisz przydział' }).click();
  await staff.getByRole('status').filter({ hasText: 'Zapisano wydane rowery.' }).waitFor();
  await staff.reload();
  await row.getByText('T-01', { exact: false }).waitFor();
  await row.getByText('D-02', { exact: false }).waitFor();
});
