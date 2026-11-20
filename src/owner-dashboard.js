import { OperationError } from './operation-error.js';

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
});

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value);
}

function dateFilter(from, to) {
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) {
    throw new OperationError(400, 'Podaj prawidłowy zakres dat.');
  }
  return (timestamp) => {
    if (!from && !to) return true;
    const date = dateFormat.format(timestamp);
    return (!from || date >= from) && (!to || date <= to);
  };
}

function reportOperation(booking, shop, timestamp) {
  return {
    bookingId: booking.id, shopId: shop.id, shopName: shop.name,
    scheduledAt: new Date(timestamp).toISOString(),
    items: booking.items.map(({ name, quantity }) => ({ name, quantity })),
  };
}

function byScheduledTime(left, right) {
  return left.scheduledAt.localeCompare(right.scheduledAt) || left.bookingId.localeCompare(right.bookingId);
}

export function openOwnerDashboard(db, { management, bookingsFor, refunds, now }) {
  const capturedPayments = db.prepare(`
    SELECT p.id, p.simulated_at, p.simulated_amount
    FROM checkouts c JOIN payments p ON p.checkout_id = c.id
    WHERE c.shop_id = ? AND p.simulated_at IS NOT NULL AND (
      p.status = 'verified' OR EXISTS (SELECT 1 FROM refund_requests r WHERE r.payment_id = p.id)
    )
  `);
  return function ownerDashboard(actor, { shopId, from, to }) {
    if (actor.role !== 'owner') throw new OperationError(403, 'Brak uprawnień do panelu właściciela.');
    if (shopId) management.accessible(actor, shopId);
    const inDateRange = dateFilter(from, to);
    const shops = management.shops(actor).map(({ id, name }) => ({ id, name }));
    const selected = shopId ? shops.filter(({ id }) => id === shopId) : shops;
    const counts = {
      confirmed: { widget: 0, staff: 0 },
      cancelled: { widget: 0, staff: 0 },
      no_show: { widget: 0, staff: 0 },
    };
    const finances = { collected: 0, refunded: 0, currency: 'PLN' };
    const pickups = [];
    const returns = [];
    const time = now();
    for (const shop of selected) {
      for (const payment of capturedPayments.all(shop.id)) {
        if (inDateRange(payment.simulated_at)) finances.collected += payment.simulated_amount;
        for (const refund of refunds.history(payment.id)) {
          if (refund.status === 'completed' && inDateRange(Date.parse(refund.resolvedAt ?? refund.requestedAt))) {
            finances.refunded += refund.amount;
          }
        }
      }

      for (const booking of bookingsFor(shop.id)) {
        if (inDateRange(booking.pickupAt)) counts[booking.status][booking.channel]++;
        if (booking.status !== 'confirmed') continue;
        if (!booking.assigned && booking.pickupAt >= time && inDateRange(booking.pickupAt)) {
          pickups.push(reportOperation(booking, shop, booking.pickupAt));
        }
        if (!booking.returned && booking.returnAt >= time && inDateRange(booking.returnAt)) {
          returns.push(reportOperation(booking, shop, booking.returnAt));
        }
      }
    }

    return { shops, counts, finances, pickups: pickups.sort(byScheduledTime), returns: returns.sort(byScheduledTime) };
  };
}
