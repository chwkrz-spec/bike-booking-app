import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Właściciel zmienia cennik punktu, a widżet wyświetla nową najniższą cenę', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const owner = await browser.newPage({
    httpCredentials: { username: 'obsluga', password: 'showcase-credentials' },
  });
  owner.setDefaultTimeout(5000);
  await owner.goto(app.origin + '/staff');
  await owner.getByText('Oferta i cennik', { exact: true }).click();
  await owner.locator('summary').filter({ hasText: /^Rower turystyczny$/ }).click();
  const rates = owner.getByRole('form', { name: 'Cennik – Rower turystyczny' });
  await rates.getByLabel('Stawka godzinowa (PLN)').fill('25');
  await rates.getByLabel('Stawka dzienna (PLN)').fill('39');
  await rates.getByLabel('Stawka 24-godzinna (PLN)').fill('99');
  await rates.getByRole('button', { name: 'Zapisz pozycję' }).click();
  await owner.getByText('Zapisano ofertę punktu.').waitFor();

  const widget = await browser.newPage();
  widget.setDefaultTimeout(5000);
  await widget.goto(app.origin);
  const returns = widget.getByLabel('Termin zwrotu', { exact: true });
  await returns.selectOption({ index: 2 });
  assert.match(await widget.getByTestId('total').textContent(), /39,00\sPLN/);
  await widget.getByRole('button', { name: 'Potwierdź wybór' }).click();
  await widget.getByLabel('Adres e-mail').waitFor();
  assert.match(await widget.locator('#checkout-total').textContent(), /39,00\sPLN/);
});
