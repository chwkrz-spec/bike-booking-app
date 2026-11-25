import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Właściciel ustawia godziny i limity punktu, a gość wybiera dostępny półgodzinny odbiór i zwrot', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T09:30:00.000Z' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const owner = await browser.newPage({ httpCredentials: { username: 'obsluga', password: 'showcase-credentials' } });
  owner.setDefaultTimeout(5000);
  await owner.goto(app.origin + '/staff');
  await owner.getByLabel('Minimalne wyprzedzenie (minuty)').fill('60');
  await owner.getByLabel('Maksymalny czas najmu (minuty)').fill('60');
  await owner.getByLabel('Wyjątki według daty').fill('2027-01-15 11:00–12:00');
  await owner.getByRole('button', { name: 'Zapisz ustawienia punktu' }).click();
  await owner.getByText('Zapisano ustawienia punktu.').waitFor();

  const widget = await browser.newPage();
  await widget.goto(app.origin);
  const pickup = widget.getByLabel('Termin odbioru', { exact: true });
  const returns = widget.getByLabel('Termin zwrotu', { exact: true });
  await pickup.selectOption('2027-01-15T10:30:00.000Z');
  await returns.locator('option[value="2027-01-15T11:00:00.000Z"]').waitFor({ state: 'attached' });
  assert.match(await pickup.locator('option:checked').textContent(), /11:30/);
  assert.match(await returns.locator('option:checked').textContent(), /12:00/);
  await widget.getByRole('button', { name: 'Potwierdź wybór' }).click();
  await widget.getByLabel('Adres e-mail').waitFor();
  assert.match(await widget.locator('#selected-slot').textContent(), /11:30.*12:00/);
});
