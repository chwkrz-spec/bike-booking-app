import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openBooking } from './booking.js';
import { OperationError } from './operation-error.js';


const assets = new Map([
  ['/assets/styles.css', ['styles.css', 'text/css']],
  ['/assets/common.js', ['common.js', 'text/javascript']],
  ['/assets/widget.js', ['widget.js', 'text/javascript']],
  ['/assets/payment.js', ['payment.js', 'text/javascript']],
  ['/assets/staff.js', ['staff.js', 'text/javascript']],
]);

async function file(response, name, type = 'text/html') {
  const content = await readFile(new URL('../public/' + name, import.meta.url));
  response.writeHead(200, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'",
  });
  response.end(content);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  let input = '';
  for await (const chunk of request) {
    input += chunk;
    if (input.length > 16_384) throw new OperationError(413, 'Formularz jest zbyt duży.');
  }
  try {
    const value = JSON.parse(input);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // Nieprawidłowy JSON jest błędem formularza.
  }
  throw new OperationError(400, 'Nieprawidłowy formularz.');
}

function credentials(value) {
  return createHash('sha256').update(value).digest();
}

export function createApp({ databasePath = ':memory:', now = Date.now, staffPassword, allowSimulatedRefunds = false } = {}) {
  const booking = openBooking({ databasePath, now });
  const staffCredential = staffPassword && credentials('Basic ' + Buffer.from('obsluga:' + staffPassword).toString('base64'));

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const method = request.method;
      const checkout = path.match(/^\/api\/checkouts\/([\w-]+)$/);

      if (path === '/api/staff/bookings' || path === '/staff') {
        if (!staffCredential || !timingSafeEqual(staffCredential, credentials(request.headers.authorization ?? ''))) {
          response.setHeader('WWW-Authenticate', 'Basic realm="Panel pokazowy"');
          return json(response, 401, { error: 'Wymagane logowanie obsługi.' });
        }
        if (method === 'GET' && path === '/staff') return await file(response, 'staff.html');
        if (method === 'GET') return json(response, 200, booking.staffBookings());
      }

      const confirmation = path.match(/^\/api\/checkouts\/([\w-]+)\/confirmation$/);
      if (method === 'GET' && confirmation) return json(response, 200, booking.confirmation(confirmation[1]));
      const paymentFailure = path.match(/^\/api\/checkouts\/([\w-]+)\/payment-failure$/);
      if (method === 'GET' && paymentFailure) return json(response, 200, booking.paymentFailure(paymentFailure[1]));
      const simulated = path.match(/^\/api\/simulator\/payments\/([\w-]+)(\/pay)?$/);
      if (simulated && method === 'GET' && !simulated[2]) return json(response, 200, booking.paymentSession(simulated[1]));
      if (simulated && method === 'POST' && simulated[2]) {
        return json(response, 200, booking.simulatePayment(simulated[1], await body(request)));
      }
      const simulatedRefund = path.match(/^\/api\/simulator\/payments\/([\w-]+)\/refund$/);
      if (allowSimulatedRefunds && method === 'POST' && simulatedRefund) {
        return json(response, 200, booking.simulateRefund(simulatedRefund[1]));
      }
      if (method === 'POST' && path === '/api/payment-notifications') {
        return json(response, 200, booking.reconcilePayment((await body(request)).paymentId));
      }

      const payment = path.match(/^\/api\/checkouts\/([\w-]+)\/payment$/);
      if (method === 'POST' && payment) return json(response, 200, booking.startPayment(payment[1], await body(request)));
      if (method === 'GET' && path === '/api/offer') return json(response, 200, booking.offer());
      if (method === 'POST' && path === '/api/checkouts') return json(response, 201, booking.hold(await body(request)));
      if (method === 'GET' && checkout) return json(response, 200, booking.checkout(checkout[1]));

      if (method === 'GET' && path === '/') return await file(response, 'widget.html');
      if (method === 'GET' && /^\/payment-simulator\/[\w-]+$/.test(path)) return await file(response, 'payment.html');
      if (method === 'GET' && assets.has(path)) return await file(response, ...assets.get(path));
      json(response, 404, { error: 'Nie znaleziono strony.' });
    } catch (error) {
      if (error instanceof OperationError) return json(response, error.status, { error: error.message });
      console.error(error);
      json(response, 500, { error: 'Wystąpił błąd. Spróbuj ponownie.' });
    }
  });

  server.on('close', () => booking.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const staffPassword = process.env.DEMO_STAFF_PASSWORD ?? randomBytes(12).toString('hex');
  const server = createApp({ databasePath: process.env.BOOKING_DATABASE ?? 'booking.sqlite', staffPassword });
  server.listen(port, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    console.log('Widżet pokazowy: ' + origin);
    console.log('Panel obsługi: ' + origin + '/staff');
    if (!process.env.DEMO_STAFF_PASSWORD) console.log('Użytkownik: obsluga. Hasło pokazowe: ' + staffPassword);
  });
}
