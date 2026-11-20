import { once } from 'node:events';
import { createApp } from '../src/server.js';

export const staffAuthorization = `Basic ${Buffer.from('obsluga:showcase-credentials').toString('base64')}`;

export async function startTestApp(t, { date = '2027-01-15T13:03:00.000Z', ...options } = {}) {
  let now = Date.parse(date);
  const server = createApp({
    now: () => now,
    databasePath: ':memory:',
    staffPassword: 'showcase-credentials',
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    advance(minutes) { now += minutes * 60_000; },
    selection(offer) {
      return { shopId: offer.shop.id, categoryId: offer.category.id, slotId: offer.slots[0].id };
    },
    async request(path, { body, headers, ...options } = {}) {
      const response = await fetch(origin + path, {
        ...options,
        headers: { ...(body && { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
