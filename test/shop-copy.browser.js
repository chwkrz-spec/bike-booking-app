import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Właściciel kopiuje ustawienia w panelu i publikuje widżet nowego punktu z własną pulą', async (t) => {
  const app = await startTestApp(t, { date: '2027-01-15T09:30:00.000Z' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const owner = await browser.newPage({ httpCredentials: { username: 'obsluga', password: 'showcase-credentials' } });
  owner.setDefaultTimeout(5000);
  await owner.goto(app.origin + '/staff');
  await owner.getByLabel('Minimalne wyprzedzenie (minuty)').fill('60');
  await owner.getByLabel('Wyjątki według daty').fill('2027-01-15 11:00–12:00');
  await owner.getByRole('button', { name: 'Zapisz ustawienia punktu' }).click();
  await owner.getByText('Zapisano ustawienia punktu.', { exact: true }).waitFor();

  await owner.getByText('Oferta i cennik', { exact: true }).click();
  await owner.locator('summary').filter({ hasText: /^Rower turystyczny$/ }).click();
  const rates = owner.getByRole('form', { name: 'Cennik – Rower turystyczny' });
  await rates.getByLabel('Stawka godzinowa (PLN)').fill('32');
  await rates.getByRole('button', { name: 'Zapisz pozycję' }).click();
  await owner.getByText('Zapisano ofertę punktu.', { exact: true }).waitFor();

  const destination = 'Punkt nad Wisłą';
  await owner.getByLabel('Nazwa nowego punktu').fill(destination);
  await owner.getByRole('button', { name: 'Dodaj punkt' }).click();
  await owner.getByText('Dodano punkt.', { exact: true }).waitFor();
  const stock = owner.getByRole('listitem').filter({ has: owner.getByLabel('Rower turystyczny', { exact: true }) });
  await stock.getByLabel('Rower turystyczny', { exact: true }).fill('3');
  await stock.getByRole('button', { name: 'Zapisz ilość' }).click();
  await owner.getByText('Zapisano ilość w puli online.', { exact: true }).waitFor();

  await owner.getByLabel('Punkt źródłowy').selectOption({ label: 'Warszawa – punkt pokazowy' });
  await owner.getByRole('button', { name: 'Skopiuj konfigurację' }).click();
  await owner.getByText('Skopiowano konfigurację punktu.', { exact: true }).waitFor();
  assert.equal(await owner.getByLabel('Wyjątki według daty').inputValue(), '2027-01-15 11:00–12:00');
  assert.equal(await stock.getByLabel('Rower turystyczny', { exact: true }).inputValue(), '3');

  const publish = owner.getByRole('form', { name: 'Utwórz widżet' });
  await publish.getByLabel('Nazwa widżetu').fill('Rezerwacje nad Wisłą');
  await publish.getByLabel('Punkt widżetu').selectOption({ label: destination });
  await publish.getByRole('button', { name: 'Utwórz widżet' }).click();
  const url = await owner.getByRole('group', { name: 'Rezerwacje nad Wisłą' })
    .getByLabel('Adres strony hostowanej').inputValue();
  const widget = await browser.newPage();
  widget.setDefaultTimeout(5000);
  await widget.goto(url);
  const pickup = widget.getByLabel('Termin odbioru', { exact: true });
  const bike = widget.getByLabel('Rower turystyczny', { exact: true });
  await bike.waitFor();
  assert.equal(await pickup.inputValue(), '2027-01-15T10:30:00.000Z');
  assert.equal(await bike.getAttribute('max'), '3');
  await bike.fill('3');
  assert.match(await widget.getByTestId('total').textContent(), /96,00\sPLN/);
  await widget.getByRole('button', { name: 'Potwierdź wybór' }).click();
  await widget.getByLabel('Adres e-mail').waitFor();
  assert.match(await widget.locator('#checkout-total').textContent(), /96,00\sPLN/);
});
