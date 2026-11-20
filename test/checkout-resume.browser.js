import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTestApp } from './support.js';

test('Gość otwiera wysłany link w innej przeglądarce i potwierdza wybór po wygaśnięciu blokady', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const original = await browser.newPage();
  await original.goto(app.origin);
  await original.getByRole('button', { name: 'Potwierdź wybór' }).click();
  await original.getByLabel('Adres e-mail').fill('powrot@example.test');
  await original.getByLabel('Numer telefonu').fill('+48 500 123 456');
  const [response] = await Promise.all([
    original.waitForResponse(/\/api\/checkouts\/[^/]+\/resume-link$/),
    original.getByRole('button', { name: 'Wyślij mi link do dokończenia rezerwacji' }).click({ timeout: 3000 }),
  ]);
  const message = await response.json();
  await original.close();
  const resumed = await browser.newPage();
  await resumed.goto(app.origin + message.resumeUrl);
  await resumed.getByLabel('Adres e-mail').waitFor();
  assert.equal(await resumed.getByLabel('Adres e-mail').inputValue(), 'powrot@example.test');
  assert.equal(await resumed.getByLabel('Numer telefonu').inputValue(), '+48 500 123 456');
  assert.equal(await resumed.locator('#hold-deadline').getAttribute('datetime'), '2027-01-15T13:18:00.000Z');

  app.advance(15);
  await resumed.reload();
  await resumed.getByRole('button', { name: 'Potwierdź aktualny wybór' }).click();
  await resumed.getByLabel('Numer telefonu').waitFor();
  assert.equal(await resumed.locator('#hold-deadline').getAttribute('datetime'), '2027-01-15T13:33:00.000Z');
  assert.equal(await resumed.getByLabel('Numer telefonu').inputValue(), '+48 500 123 456');
});
