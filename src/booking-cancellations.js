import { randomUUID } from 'node:crypto';
import { amendedBooking } from './booking-amendments.js';
import { cancellationRefund } from './cancellation-policy.js';
import { OperationError } from './operation-error.js';

export function openBookingCancellations(db, {
  policies, refunds, simulator, management, now, itemsForBooking, allocationForBooking, canCancelBooking,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_links (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      token TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS booking_cancellations (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      source TEXT NOT NULL,
      cancelled_at INTEGER NOT NULL
    ) STRICT;
  `);
  const tokenByBooking = db.prepare('SELECT token FROM booking_links WHERE booking_id = ?');
  const saveToken = db.prepare('INSERT INTO booking_links VALUES (?, ?) ON CONFLICT(booking_id) DO NOTHING');
  const renterBooking = db.prepare(`
    SELECT b.id AS booking_id, b.payment_id, c.*, amended.state AS amendment_state FROM booking_links l
    JOIN bookings b ON b.id = l.booking_id JOIN checkouts c ON c.id = b.checkout_id
    LEFT JOIN booking_amendment_state amended ON amended.booking_id = b.id
    WHERE l.token = ?
  `);
  const staffBooking = db.prepare(`
    SELECT b.id AS booking_id, b.payment_id, c.*, amended.state AS amendment_state FROM bookings b
    JOIN checkouts c ON c.id = b.checkout_id
    LEFT JOIN booking_amendment_state amended ON amended.booking_id = b.id WHERE b.id = ?
  `);
  const readCancellation = db.prepare('SELECT * FROM booking_cancellations WHERE booking_id = ?');
  const recordCancellation = db.prepare('INSERT INTO booking_cancellations VALUES (?, ?, ?)');
  const release = db.prepare('UPDATE checkouts SET status = ? WHERE id = ?');

  function find(statement, id) {
    const booking = statement.get(id);
    if (!booking) throw new OperationError(404, 'Nie znaleziono rezerwacji.');
    return amendedBooking(booking);
  }

  function view(booking, time) {
    const policy = policies.agreed(booking);
    const cancellation = readCancellation.get(booking.booking_id);
    const refund = cancellation && refunds.getByKey(booking.payment_id, 'whole-booking-cancellation');
    const canCancel = canCancelBooking(booking) && time < booking.pickup_at;
    const allocation = allocationForBooking(booking);
    return {
      id: booking.booking_id,
      shopName: management.publicShop(booking.shop_id).shop.name,
      items: itemsForBooking(booking),
      ...(allocation && { allocatedItems: allocation }),
      pickupAt: new Date(booking.pickup_at).toISOString(),
      returnAt: new Date(booking.return_at).toISOString(),
      total: booking.total,
      currency: 'PLN',
      status: booking.status,
      ...policy,
      canCancel,
      ...(canCancel && { cancellationRefund: cancellationRefund(booking, policy, time, 'renter') }),
      ...(cancellation && {
        cancelledAt: new Date(cancellation.cancelled_at).toISOString(),
        cancellationSource: cancellation.source,
        cancellationRefund: refund?.amount ?? 0,
        ...(refund && { refundStatus: refund.status }),
      }),
    };
  }

  function canMarkNoShow(booking, time) {
    return canCancelBooking(booking) && time >= booking.pickup_at + policies.agreed(booking).noShowGraceMinutes * 60_000;
  }

  function cancel(booking, time, source, { approvedBy, expectedRefund } = {}) {
    const previous = readCancellation.get(booking.booking_id);
    if (previous && (previous.source === 'no-show') === (source === 'no-show')) return view(booking, time);
    if (source === 'no-show' && !canMarkNoShow(booking, time)) {
      throw new OperationError(409, 'Nie można oznaczyć No-Show przed upływem czasu oczekiwania lub po wydaniu sprzętu.');
    }
    if (!canCancelBooking(booking) || (source === 'renter' && time >= booking.pickup_at)) {
      throw new OperationError(409, 'Nie można anulować tej rezerwacji.');
    }

    const amount = Math.min(cancellationRefund(booking, policies.agreed(booking), time, source), refunds.remaining(booking.payment_id, booking.total));
    if (expectedRefund !== undefined && expectedRefund !== amount) {
      throw new OperationError(409, 'Kwota zwrotu się zmieniła. Sprawdź aktualną kwotę przed anulowaniem.');
    }
    if (amount > 0) {
      refunds.start(simulator.get(booking.payment_id), {
        key: 'whole-booking-cancellation', reason: source + '-cancellation', amount, time, approvedBy,
      });
    }
    recordCancellation.run(booking.booking_id, source, time);
    const status = source === 'no-show' ? 'no_show' : 'cancelled';
    release.run(status, booking.id);
    return view({ ...booking, status }, time);
  }

  return {
    privateUrl(bookingId) {
      if (!tokenByBooking.get(bookingId)) saveToken.run(bookingId, randomUUID());
      return '/booking/' + tokenByBooking.get(bookingId).token;
    },
    renterView(token) {
      return view(find(renterBooking, token), now());
    },
    renterCancel(token, { expectedRefund }) {
      return cancel(find(renterBooking, token), now(), 'renter', { expectedRefund });
    },
    partnerCancel(actor, id) {
      const booking = find(staffBooking, id);
      if (!management.accessible(actor, booking.shop_id).canRefund) {
        throw new OperationError(403, 'Ta operacja wymaga uprawnień do zwrotów.');
      }
      return cancel(booking, now(), 'partner', { approvedBy: actor.username });
    },
    markNoShow(actor, shopId, id) {
      management.accessible(actor, shopId);
      const booking = find(staffBooking, id);
      if (booking.shop_id !== shopId) throw new OperationError(404, 'Nie znaleziono rezerwacji.');
      return cancel(booking, now(), 'no-show');
    },
    staffSummary(actor, booking, time) {
      const { canRefund } = management.accessible(actor, booking.shop_id);
      const canCancel = canRefund && canCancelBooking(booking);
      const refund = booking.status === 'cancelled' && refunds.getByKey(booking.payment_id, 'whole-booking-cancellation');
      return {
        canCancel,
        ...(canCancel && { partnerCancellationRefund: refunds.remaining(booking.payment_id, booking.total) }),
        canMarkNoShow: canMarkNoShow(booking, time),
        ...(['cancelled', 'no_show'].includes(booking.status) && { cancellationRefund: refund?.amount ?? 0 }),
      };
    },
    staffRefunds(actor, id) {
      const booking = find(staffBooking, id);
      management.accessible(actor, booking.shop_id);
      return refunds.history(booking.payment_id);
    },
  };
}
