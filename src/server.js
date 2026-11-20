import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { openBooking } from './booking.js';
import { OperationError } from './operation-error.js';


const assets = new Map([
  ['/assets/styles.css', ['styles.css', 'text/css']],
  ['/assets/common.js', ['common.js', 'text/javascript']],
  ['/assets/renter-language.js', ['renter-language.js', 'text/javascript']],
  ['/assets/widget.js', ['widget.js', 'text/javascript']],
  ['/assets/widget-context.js', ['widget-context.js', 'text/javascript']],
  ['/assets/widget-popup.js', ['widget-popup.js', 'text/javascript']],
  ['/assets/payment.js', ['payment.js', 'text/javascript']],
  ['/assets/booking.js', ['booking.js', 'text/javascript']],
  ['/assets/staff.js', ['staff.js', 'text/javascript']],
  ['/assets/owner-dashboard.js', ['owner-dashboard.js', 'text/javascript']],
  ['/assets/owner-dashboard.css', ['owner-dashboard.css', 'text/css']],
  ['/assets/staff-amendments.js', ['staff-amendments.js', 'text/javascript']],
  ['/assets/staff-assisted.js', ['staff-assisted.js', 'text/javascript']],
  ['/assets/staff-checkout.js', ['staff-checkout.js', 'text/javascript']],
  ['/assets/staff-equipment.js', ['staff-equipment.js', 'text/javascript']],
  ['/assets/staff-widgets.js', ['staff-widgets.js', 'text/javascript']],
]);

async function file(response, name, type = 'text/html', { widgetMode } = {}) {
  const content = await readFile(new URL('../public/' + name, import.meta.url));
  let policy = "default-src 'self'; object-src 'none'; base-uri 'none'";
  if (widgetMode) policy += "; img-src 'self' https:";
  if (widgetMode && widgetMode !== 'inline') policy += "; frame-ancestors 'none'";
  response.writeHead(200, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': policy,
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

async function staffBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new OperationError(415, 'Prześlij dane w formacie JSON.');
  }
  return body(request);
}

export function createApp({
  databasePath = ':memory:',
  now = Date.now,
  staffPassword,
  demoOwners = [],
  allowSimulatedRefunds = false,
} = {}) {
  const booking = openBooking({ databasePath, now, staffPassword, demoOwners });
  const { management, widgets } = booking;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      const checkout = path.match(/^\/api\/checkouts\/([\w-]+)$/);

      if (path === '/staff' || path === '/staff/owner-dashboard' || path.startsWith('/api/staff/')) {
        const actor = management.authenticate(request.headers.authorization);
        if (!actor) {
          response.setHeader('WWW-Authenticate', 'Basic realm="Panel pokazowy"');
          return json(response, 401, { error: 'Wymagane logowanie obsługi.' });
        }
        if (method === 'GET' && path === '/staff') return await file(response, 'staff.html');
        if (method === 'GET' && path === '/staff/owner-dashboard') {
          if (actor.role !== 'owner') throw new OperationError(403, 'Brak uprawnień do panelu właściciela.');
          return await file(response, 'owner-dashboard.html');
        }
        if (path === '/api/staff/session' && method === 'GET') return json(response, 200, { role: actor.role });
        if (path === '/api/staff/owner-dashboard' && method === 'GET') {
          return json(response, 200, booking.ownerDashboard(actor, Object.fromEntries(url.searchParams)));
        }
        if (path === '/api/staff/bookings' && method === 'GET') {
          return json(response, 200, booking.staffBookings(actor));
        }
        const staffBooking = path.match(/^\/api\/staff\/bookings\/([\w-]+)\/(cancel|refunds)$/);
        if (staffBooking?.[2] === 'cancel' && method === 'POST') {
          await staffBody(request);
          return json(response, 200, booking.cancelPartnerBooking(actor, staffBooking[1]));
        }
        if (staffBooking?.[2] === 'refunds' && method === 'GET') {
          return json(response, 200, booking.bookingRefunds(actor, staffBooking[1]));
        }
        if (path === '/api/staff/shops') {
          if (method === 'GET') return json(response, 200, management.shops(actor));
          if (method === 'POST') return json(response, 201, management.createShop(actor, await staffBody(request)));
        }
        if (path === '/api/staff/cancellation-policy') {
          if (method === 'GET') return json(response, 200, booking.cancellationPolicy(actor));
          if (method === 'POST') {
            return json(response, 200, booking.cancellationPolicy(actor, await staffBody(request)));
          }
        }
        if (path === '/api/staff/partner') {
          if (method === 'GET') return json(response, 200, management.partner(actor));
          if (method === 'POST') return json(response, 200, management.partner(actor, await staffBody(request)));
        }
        if (path === '/api/staff/widget-branding') {
          if (method === 'GET') return json(response, 200, widgets.branding(actor));
          if (method === 'POST') return json(response, 200, widgets.branding(actor, await staffBody(request)));
        }
        if (path === '/api/staff/widgets') {
          if (method === 'GET') return json(response, 200, widgets.list(actor));
          if (method === 'POST') return json(response, 201, widgets.create(actor, await staffBody(request)));
        }
        if (path === '/api/staff/members') {
          if (method === 'GET') return json(response, 200, management.members(actor));
          if (method === 'POST') return json(response, 201, management.createMember(actor, await staffBody(request)));
        }
        const assignment = path.match(/^\/api\/staff\/members\/([\w-]+)\/assignments$/);
        if (assignment && method === 'POST') {
          return json(response, 200, management.assignment(actor, assignment[1], await staffBody(request)));
        }
        const amendment = path.match(/^\/api\/staff\/shops\/([\w-]+)\/bookings\/([\w-]+)\/(amendment|change)(\/preview)?$/);
        if (amendment && method === 'POST') {
          const [, shopId, bookingId, action, preview] = amendment;
          const input = await staffBody(request);
          if (action === 'change') {
            const result = preview ? booking.previewBookingChange(actor, shopId, bookingId, input)
              : booking.approveBookingChange(actor, shopId, bookingId, input);
            return json(response, 200, result);
          }
          const result = preview ? booking.previewPickupAmendment(actor, shopId, bookingId, input)
            : booking.approvePickupAmendment(actor, shopId, bookingId, input);
          return json(response, 200, result);
        }
        const fulfilment = path.match(/^\/api\/staff\/shops\/([\w-]+)\/bookings\/([\w-]+)\/(pickup|return|no-show|substitute)$/);
        if (fulfilment && method === 'POST') {
          const [, shopId, bookingId, action] = fulfilment;
          const input = await staffBody(request);
          if (action === 'pickup') return json(response, 200, booking.assignPickup(actor, shopId, bookingId, input));
          if (action === 'substitute') return json(response, 200, booking.substituteEquipment(actor, shopId, bookingId, input));
          if (action === 'return') return json(response, 200, booking.returnEquipment(actor, shopId, bookingId));
          return json(response, 200, booking.markNoShow(actor, shopId, bookingId));
        }
        const assisted = path.match(/^\/api\/staff\/shops\/([\w-]+)\/(assisted-offer|payment-links)$/);
        if (assisted?.[2] === 'assisted-offer' && method === 'GET') {
          return json(response, 200, booking.staffOffer(actor, assisted[1],
            url.searchParams.get('pickupAt') ?? undefined, url.searchParams.get('replacing') ?? undefined));
        }
        if (assisted?.[2] === 'payment-links' && method === 'POST') {
          return json(response, 201, booking.sendStaffPaymentLink(actor, assisted[1], await staffBody(request)));
        }
        if (assisted?.[2] === 'payment-links' && method === 'GET') {
          return json(response, 200, booking.staffPaymentLinks(actor, assisted[1]));
        }
        const replacement = path.match(/^\/api\/staff\/shops\/([\w-]+)\/payment-links\/([\w-]+)\/replace$/);
        if (replacement && method === 'POST') {
          return json(response, 201, booking.sendStaffPaymentLink(actor, replacement[1], await staffBody(request), replacement[2]));
        }
        const shopCopy = path.match(/^\/api\/staff\/shops\/([\w-]+)\/copy-configuration$/);
        if (shopCopy && method === 'POST') {
          return json(response, 200, management.copyConfiguration(actor, shopCopy[1], await staffBody(request)));
        }
        const shopRoute = path.match(/^\/api\/staff\/shops\/([\w-]+)\/(settings|stock|catalog|bookings|renter-copy)$/);
        if (shopRoute) {
          const [, shopId, resource] = shopRoute;
          if (resource === 'renter-copy') {
            if (method === 'GET') return json(response, 200, management.renterCopy(actor, shopId));
            if (method === 'POST') return json(response, 200, management.renterCopy(actor, shopId, await staffBody(request)));
          }
          if (resource === 'settings') {
            if (method === 'GET') return json(response, 200, management.settings(actor, shopId));
            if (method === 'POST') return json(response, 200, management.settings(actor, shopId, await staffBody(request)));
          }
          if (resource === 'catalog') {
            if (method === 'GET') return json(response, 200, management.catalog(actor, shopId));
            if (method === 'POST') {
              const input = await staffBody(request);
              return json(response, input.id === undefined ? 201 : 200, management.catalog(actor, shopId, input));
            }
          }
          if (resource === 'stock') {
            if (method === 'GET') return json(response, 200, management.stock(actor, shopId));
            if (method === 'POST') return json(response, 200, management.stock(actor, shopId, await staffBody(request)));
          }
          if (method === 'GET' && resource === 'bookings') return json(response, 200, booking.staffBookings(actor, shopId));
        }
      }

      const renterBooking = path.match(/^\/api\/bookings\/([\w-]+)(\/cancel)?$/);
      if (renterBooking && method === 'GET' && !renterBooking[2]) {
        return json(response, 200, booking.renterBooking(renterBooking[1]));
      }
      if (renterBooking && method === 'POST' && renterBooking[2]) {
        return json(response, 200, booking.cancelRenterBooking(renterBooking[1], await staffBody(request)));
      }

      const assistedCheckout = path.match(/^\/api\/staff-checkout\/([\w-]+)$/);
      if (method === 'GET' && assistedCheckout) return json(response, 200, booking.staffCheckout(assistedCheckout[1]));

      const confirmation = path.match(/^\/api\/checkouts\/([\w-]+)\/confirmation$/);
      if (method === 'GET' && confirmation) return json(response, 200, booking.confirmation(confirmation[1]));
      const paymentFailure = path.match(/^\/api\/checkouts\/([\w-]+)\/payment-failure$/);
      if (method === 'GET' && paymentFailure) return json(response, 200, booking.paymentFailure(paymentFailure[1]));
      const simulated = path.match(/^\/api\/simulator\/payments\/([\w-]+)(?:\/(pay|complete))?$/);
      if (simulated && method === 'GET' && !simulated[2]) return json(response, 200, booking.paymentSession(simulated[1]));
      if (method === 'POST' && simulated?.[2] === 'pay') {
        return json(response, 200, booking.simulatePayment(simulated[1], await body(request)));
      }
      if (method === 'POST' && simulated?.[2] === 'complete') {
        return json(response, 200, booking.completeSimulatedPayment(simulated[1]));
      }
      const refundResolution = path.match(/^\/api\/simulator\/refunds\/([\w-]+)$/);
      if (allowSimulatedRefunds && refundResolution && method === 'POST') {
        return json(response, 200, booking.simulateRefundResolution(refundResolution[1], await body(request)));
      }
      const simulatedRefund = path.match(/^\/api\/simulator\/payments\/([\w-]+)\/refund$/);
      if (allowSimulatedRefunds && method === 'POST' && simulatedRefund) {
        return json(response, 200, booking.simulateRefund(simulatedRefund[1]));
      }
      if (method === 'POST' && path === '/api/payment-notifications') {
        return json(response, 200, booking.reconcilePayment((await body(request)).paymentId));
      }

      const resumeLink = path.match(/^\/api\/checkouts\/([\w-]+)\/resume-link$/);
      if (method === 'POST' && resumeLink) {
        return json(response, 201, booking.issueResumeLink(resumeLink[1], await body(request)));
      }
      const resumeCheckout = path.match(/^\/api\/checkout-resume\/([\w-]+)(\/confirm)?$/);
      if (method === 'GET' && resumeCheckout && !resumeCheckout[2]) {
        return json(response, 200, booking.resumeCheckout(resumeCheckout[1]));
      }
      if (method === 'POST' && resumeCheckout?.[2]) {
        return json(response, 200, booking.confirmResumedSelection(resumeCheckout[1], await body(request)));
      }
      const resumeDraft = path.match(/^\/api\/checkouts\/([\w-]+)\/resume-draft$/);
      if (method === 'POST' && resumeDraft) {
        return json(response, 200, booking.saveResumeDraft(resumeDraft[1], await body(request)));
      }

      const payment = path.match(/^\/api\/checkouts\/([\w-]+)\/payment$/);
      if (method === 'POST' && payment) return json(response, 200, booking.startPayment(payment[1], await body(request)));
      const widgetConfig = path.match(/^\/api\/widgets\/([\w-]+)$/);
      if (method === 'GET' && widgetConfig) return json(response, 200, widgets.configuration(widgetConfig[1]));
      const widgetOffer = path.match(/^\/api\/widgets\/([\w-]+)\/offer$/);
      if (method === 'GET' && widgetOffer) {
        const shopId = widgets.selectedShop(widgetOffer[1], url.searchParams.get('shopId'));
        const language = url.searchParams.get('language') ?? undefined;
        return json(response, 200, booking.offer(shopId, url.searchParams.get('pickupAt') ?? undefined, { language }));
      }
      const widgetCheckout = path.match(/^\/api\/widgets\/([\w-]+)\/checkouts$/);
      if (method === 'POST' && widgetCheckout) {
        const selection = await body(request);
        const shopId = widgets.selectedShop(widgetCheckout[1], selection.shopId);
        return json(response, 201, booking.hold({ ...selection, shopId }));
      }
      if (method === 'GET' && path === '/api/offer') {
        return json(response, 200, booking.offer(
          url.searchParams.get('shopId') ?? undefined, url.searchParams.get('pickupAt') ?? undefined,
          { language: url.searchParams.get('language') ?? undefined },
        ));
      }
      if (method === 'POST' && path === '/api/checkouts') return json(response, 201, booking.hold(await body(request)));
      if (method === 'GET' && checkout) return json(response, 200, booking.checkout(checkout[1]));

      if (method === 'GET' && /^\/booking\/[\w-]+$/.test(path)) return await file(response, 'booking.html');
      const widgetPage = path.match(/^\/widgets\/([\w-]+)(?:\/(inline|popup))?$/);
      if (method === 'GET' && widgetPage) {
        const [, widgetId, widgetMode = 'hosted'] = widgetPage;
        widgets.published(widgetId, widgetMode);
        return await file(response, 'widget.html', 'text/html', { widgetMode });
      }
      if (method === 'GET' && /^\/checkout-resume\/[\w-]+$/.test(path)) return await file(response, 'widget.html');
      const staffCheckoutPage = path.match(/^\/staff-checkout\/([\w-]+)$/);
      if (method === 'GET' && staffCheckoutPage) {
        booking.staffCheckout(staffCheckoutPage[1]);
        return await file(response, 'staff-checkout.html');
      }
      if (method === 'GET' && path === '/') return await file(response, 'widget.html');
      if (method === 'GET' && /^\/payment-simulator\/[\w-]+$/.test(path)) return await file(response, 'payment.html');
      if (method === 'GET' && assets.has(path)) return await file(response, ...assets.get(path));
      json(response, 404, { error: 'Nie znaleziono strony.' });
    } catch (error) {
      if (error instanceof OperationError) {
        return json(response, error.status, { error: error.message, ...(error.language === 'en' && { language: 'en' }) });
      }
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
