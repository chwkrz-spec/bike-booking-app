import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { staffAuthorization, startTestApp } from './support.js';

const authorization = { Authorization: staffAuthorization };
const shopName = 'Warszawa – punkt pokazowy';
const logo = 'https://logo.example.test/bike.png';

test('Panel udostępnia formularz hostowany, inline i popup ze wspólnym brandingiem i bieżącym terminem', async (t) => {
  const app = await startTestApp(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const owner = await browser.newPage({
    httpCredentials: { username: 'obsluga', password: 'showcase-credentials' },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  owner.setDefaultTimeout(6000);
  await owner.goto(app.origin + '/staff');
  const branding = owner.getByRole('form', { name: 'Wygląd widżetów' });
  await branding.getByLabel('Adres HTTPS logo').fill(logo);
  await branding.getByLabel('Kolor akcentu').fill('#174165');
  await branding.getByLabel('Kolor tła').fill('#edf4fb');
  await branding.getByRole('button', { name: 'Zapisz wygląd' }).click();
  await owner.getByRole('status').filter({ hasText: 'Zapisano wygląd widżetów.' }).waitFor();

  const publish = owner.getByRole('form', { name: 'Utwórz widżet' });
  async function publishWidget(name, mode, shop) {
    await publish.getByLabel('Nazwa widżetu').fill(name);
    await publish.getByLabel('Sposób udostępnienia').selectOption(mode);
    if (shop) await publish.getByLabel('Punkt widżetu').selectOption({ label: shop });
    await publish.getByRole('button', { name: 'Utwórz widżet' }).click();
    const widget = owner.getByRole('group', { name });
    await widget.getByRole('button', { name: 'Kopiuj' }).click();
    await widget.getByRole('status').filter({ hasText: 'Skopiowano.' }).waitFor();
    return owner.evaluate(() => navigator.clipboard.readText());
  }

  const hosted = await publishWidget('Strona rezerwacji', 'hosted');
  const inline = await publishWidget('Formularz Warszawy', 'inline', shopName);
  const popup = await publishWidget('Przycisk rezerwacji', 'popup', shopName);

  const host = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="pl"><title>Strona Partnera</title>' +
      (request.url === '/inline' ? inline : popup) + '</html>');
  });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  t.after(() => new Promise((resolve) => host.close(resolve)));
  const partnerSite = 'http://localhost:' + host.address().port;

  const renter = await browser.newContext();
  renter.setDefaultTimeout(6000);
  await renter.route(logo, (route) => route.fulfill({
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lKcAAAAASUVORK5CYII=', 'base64'),
    contentType: 'image/png',
  }));
  const hostedPage = await renter.newPage();
  await hostedPage.goto(hosted);
  await hostedPage.getByRole('heading', { name: 'Zarezerwuj rower' }).waitFor();
  await hostedPage.getByLabel('Kategoria roweru').waitFor();
  assert.equal(await hostedPage.getByLabel('Wybierz punkt').isVisible(), false);

  const { body: secondShop } = await app.request('/api/staff/shops', {
    headers: authorization, method: 'POST', body: { name: 'Żyrardów' },
  });
  await hostedPage.reload();
  const picker = hostedPage.getByLabel('Wybierz punkt');
  await picker.waitFor();
  await picker.selectOption(secondShop.id);
  await hostedPage.locator('#shop-name').filter({ hasText: /^Żyrardów$/ }).waitFor();
  await picker.selectOption({ label: shopName });

  const inlineParent = await renter.newPage();
  await inlineParent.goto(partnerSite + '/inline');
  const inlinePage = inlineParent.frameLocator('iframe');
  const popupParent = await renter.newPage();
  await popupParent.goto(partnerSite + '/popup');
  const [popupPage] = await Promise.all([
    popupParent.waitForEvent('popup'),
    popupParent.getByRole('button', { name: 'Zarezerwuj rower' }).click(),
  ]);

  async function checkOffers(pages) {
    for (const page of pages) {
      await page.locator('#shop-name').filter({ hasText: shopName }).waitFor();
      await page.getByLabel('Kategoria roweru').waitFor();
      assert.equal(await page.getByAltText('Logo Partnera').evaluate((image) => image.getAttribute('src')), logo);
      assert.equal(await page.getByRole('button', { name: 'Potwierdź wybór' }).evaluate(
        (button) => getComputedStyle(button).backgroundColor,
      ), 'rgb(23, 65, 101)');
      assert.match(await page.getByTestId('total').textContent(), /20,00\sPLN/);
    }
  }

  const pages = [hostedPage, inlinePage, popupPage];
  await checkOffers(pages);
  assert.equal(await inlinePage.getByLabel('Wybierz punkt').isVisible(), false);
  assert.equal(await popupPage.getByLabel('Wybierz punkt').isVisible(), false);
  const initialPickup = await hostedPage.getByLabel('Termin odbioru').inputValue();
  for (const page of pages) assert.equal(await page.getByLabel('Termin odbioru').inputValue(), initialPickup);

  const saved = await app.request('/api/staff/shops/warszawa-demo/settings', {
    headers: authorization, method: 'POST', body: { minimumNoticeMinutes: 240 },
  });
  assert.equal(saved.status, 200);
  await Promise.all([hostedPage.reload(), inlineParent.reload(), popupPage.reload()]);
  await checkOffers(pages);
  const newPickup = await hostedPage.getByLabel('Termin odbioru').inputValue();
  assert.notEqual(newPickup, initialPickup);
  for (const page of pages) {
    assert.equal(await page.getByLabel('Termin odbioru').inputValue(), newPickup);
    await page.getByLabel('Termin zwrotu').selectOption({ index: 2 });
    assert.match(await page.getByTestId('total').textContent(), /40,00\sPLN/);
  }

  await inlinePage.getByRole('button', { name: 'Potwierdź wybór' }).click();
  await inlinePage.getByLabel('Adres e-mail').waitFor();
  await Promise.all([hostedPage.reload(), popupPage.reload()]);
  await checkOffers([hostedPage, popupPage]);
  for (const page of [hostedPage, popupPage]) {
    assert.notEqual(await page.getByLabel('Termin odbioru').inputValue(), newPickup);
  }
});
