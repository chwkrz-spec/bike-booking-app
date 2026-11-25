import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staffAuthorization, startTestApp } from './support.js';

const headers = { Authorization: staffAuthorization };
const post = (body) => ({ headers, method: 'POST', body });

test('Właściciel zarządza jednym brandingiem dla widżetów Partnera', async (t) => {
  const app = await startTestApp(t);
  const branding = { logoUrl: 'https://logo.example.test/bike.png', accentColor: '#174165', backgroundColor: '#edf4fb' };
  const updated = await app.request('/api/staff/widget-branding', post(branding));
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, branding);

  const { body: picker } = await app.request('/api/staff/widgets', post({ name: 'Strona główna', delivery: 'hosted' }));
  const { body: fixed } = await app.request('/api/staff/widgets', post({
    name: 'Strona punktu', delivery: 'inline', shopId: 'warszawa-demo',
  }));
  for (const widget of [picker, fixed]) {
    const { body } = await app.request('/api/widgets/' + widget.id);
    assert.deepEqual(body.branding, branding);
    assert.equal(body.shopId, 'warszawa-demo');
    assert.deepEqual(body.shops.map(({ id }) => id), ['warszawa-demo']);
  }

  const { body: second } = await app.request('/api/staff/shops', post({ name: 'Łódź' }));
  const pickerWithTwoShops = await app.request('/api/widgets/' + picker.id);
  assert.equal(pickerWithTwoShops.body.shopId, null);
  assert.deepEqual(new Set(pickerWithTwoShops.body.shops.map(({ id }) => id)), new Set(['warszawa-demo', second.id]));
  const fixedWithTwoShops = await app.request('/api/widgets/' + fixed.id);
  assert.equal(fixedWithTwoShops.body.shopId, 'warszawa-demo');
  assert.deepEqual(fixedWithTwoShops.body.shops.map(({ id }) => id), ['warszawa-demo']);
});

test('Widżet pokazuje bieżącą ofertę własnego punktu i nie przyjmuje innego punktu', async (t) => {
  const app = await startTestApp(t, {
    demoOwners: [{ username: 'drugi', password: 'syntetyczne-haslo', partnerId: 'drugi-partner' }],
  });
  const otherHeaders = { Authorization: 'Basic ' + Buffer.from('drugi:syntetyczne-haslo').toString('base64') };
  const { body: otherShop } = await app.request('/api/staff/shops', {
    headers: otherHeaders, method: 'POST', body: { name: 'Inny Partner' },
  });
  assert.equal((await app.request('/api/staff/widgets', post({
    name: 'Inny Partner', delivery: 'inline', shopId: otherShop.id,
  }))).status, 404);

  const { body: widget } = await app.request('/api/staff/widgets', post({
    name: 'Formularz', delivery: 'hosted', shopId: 'warszawa-demo',
  }));
  const path = '/api/widgets/' + widget.id;
  assert.deepEqual((await app.request('/api/staff/widgets', { headers: otherHeaders })).body, []);
  assert.equal((await app.request(path + '/offer?shopId=' + otherShop.id)).status, 404);
  assert.equal((await app.request(path + '/checkouts', {
    method: 'POST', body: { shopId: otherShop.id },
  })).status, 404);

  const before = await app.request(path + '/offer');
  assert.equal(before.status, 200);
  assert.equal(before.body.shop.id, 'warszawa-demo');
  assert.equal(before.body.slots[0].total, 2000);
  const held = await app.request(path + '/checkouts', { method: 'POST', body: app.selection(before.body) });
  assert.equal(held.status, 201);
  const updated = await app.request(path + '/offer');
  const updatedSlot = updated.body.slots.find(({ id }) => id === before.body.slots[0].id);
  assert.equal(updatedSlot.availableQuantities[before.body.category.id], 0);
  assert.equal(updatedSlot.availableQuantities['rower-dzieciecy'], 2);
});
