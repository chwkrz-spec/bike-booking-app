import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bookingCalendar, provisionalHourlyTotal } from './booking-calendar.js';
import { category, shop } from './catalog.js';
import { OperationError } from './operation-error.js';
import { createPaymentSimulator } from './payment-simulator.js';
import { openShopManagement } from './shop-management.js';

const holdDuration = 15 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function renterDetails(input) {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const { riderHeight, acceptedTerms } = input;
  const phoneDigits = phone.replace(/[^0-9]/g, '').length;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OperationError(400, 'Podaj prawidłowy adres e-mail.');
  }
  if (!/^\+?[0-9 ()-]+$/.test(phone) || phoneDigits < 7 || phoneDigits > 15) {
    throw new OperationError(400, 'Podaj prawidłowy numer telefonu.');
  }
  if (!Number.isInteger(riderHeight) || riderHeight < 50 || riderHeight > 250) {
    throw new OperationError(400, 'Podaj wzrost uczestnika w centymetrach.');
  }
  if (acceptedTerms !== true) {
    throw new OperationError(400, 'Zaakceptuj warunki najmu.');
  }
  return { email, phone, riderHeight };
}

function describeCheckout(row, now, payment) {
  return {
    id: row.id,
    status: row.deadline <= now && ['held', 'payment'].includes(row.status) ? 'expired' : row.status,
    shopId: row.shop_id,
    categoryId: row.category_id,
    pickupAt: new Date(row.pickup_at).toISOString(),
    returnAt: new Date(row.return_at).toISOString(),
    expiresAt: new Date(row.deadline).toISOString(),
    serverTime: new Date(now).toISOString(),
    total: row.total,
    currency: 'PLN',
    ...(payment && { paymentUrl: '/payment-simulator/' + payment.id }),
  };
}

export function openBooking({ databasePath, now, staffPassword, demoOwners }) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY,
      request_id TEXT UNIQUE,
      shop_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      pickup_at INTEGER NOT NULL,
      return_at INTEGER NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL,
      deadline INTEGER NOT NULL,
      email TEXT,
      phone TEXT,
      rider_height INTEGER,
      terms_text TEXT,
      terms_accepted_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(id),
      status TEXT NOT NULL,
      simulated_amount INTEGER,
      simulated_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(id),
      payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
      confirmed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS confirmation_messages (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS payment_failure_messages (
      payment_id TEXT PRIMARY KEY REFERENCES payments(id),
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS checkout_stock ON checkouts(shop_id, category_id, pickup_at, return_at);
  `);
  const management = openShopManagement(db, { staffPassword, demoOwners });
  const simulator = createPaymentSimulator(db);
  const selectBooking = db.prepare('SELECT * FROM bookings WHERE payment_id = ?');
  const insertBooking = db.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO confirmation_messages VALUES (?, ?, ?, ?)');
  const selectMessage = db.prepare(`
    SELECT b.id AS bookingId, m.recipient AS 'to', m.subject, m.content
    FROM bookings b JOIN confirmation_messages m ON m.booking_id = b.id
    WHERE b.checkout_id = ?
  `);
  const insertFailureMessage = db.prepare('INSERT INTO payment_failure_messages VALUES (?, ?, ?, ?)');
  const selectFailureMessage = db.prepare(`
    SELECT m.recipient AS 'to', m.subject, m.content
    FROM payments p JOIN payment_failure_messages m ON m.payment_id = p.id
    WHERE p.checkout_id = ?
  `);
  const listBookings = db.prepare(`
    SELECT b.id AS booking_id, c.* FROM bookings b JOIN checkouts c ON c.id = b.checkout_id
    WHERE c.shop_id = ? ORDER BY c.pickup_at, b.id
  `);
  const confirmCheckout = db.prepare("UPDATE checkouts SET status = 'confirmed' WHERE id = ?");
  const refundCheckout = db.prepare("UPDATE checkouts SET status = 'refund_started' WHERE id = ?");
  const verifyPayment = db.prepare("UPDATE payments SET status = 'verified' WHERE id = ?");
  const selectRetry = db.prepare('SELECT * FROM checkouts WHERE request_id = ?');
  const checkoutPayment = db.prepare('SELECT * FROM payments WHERE checkout_id = ?');
  const insertPayment = db.prepare("INSERT INTO payments (id, checkout_id, status) VALUES (?, ?, 'pending')");
  const startPayment = db.prepare(`
    UPDATE checkouts SET status = 'payment', deadline = ?, email = ?, phone = ?, rider_height = ?,
      terms_text = ?, terms_accepted_at = ? WHERE id = ?
  `);
  const selectCheckout = db.prepare('SELECT * FROM checkouts WHERE id = ?');
  const occupied = db.prepare(`
    SELECT COUNT(*) AS quantity FROM checkouts
    WHERE shop_id = ? AND category_id = ? AND pickup_at < ? AND return_at > ?
      AND (status = 'confirmed' OR (status IN ('held', 'payment') AND deadline > ?))
  `);
  const insertCheckout = db.prepare(`
    INSERT INTO checkouts (id, request_id, shop_id, category_id, pickup_at, return_at, total, status, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)
  `);

  function available(slot, timestamp, shopId = shop.id) {
    return occupied.get(shopId, category.id, slot.returnAt, slot.pickupAt, timestamp).quantity < category.stock;
  }

  function firstAvailableReturns(calendar, pickupAt, timestamp, shopId, limit = Infinity) {
    const slots = [];
    for (const slot of calendar.returnsFor(pickupAt)) {
      if (!available(slot, timestamp, shopId)) break;
      slots.push(slot);
      if (slots.length === limit) break;
    }
    return slots;
  }

  function checkout(id) {
    const current = selectCheckout.get(id);
    if (!current) throw new OperationError(404, 'Nie znaleziono blokady.');
    return current;
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    management,
    offer(shopId, pickupAt) {
      const time = now();
      const { shop: selectedShop, settings } = management.publicShop(shopId);
      const calendar = bookingCalendar(settings, time);
      const slots = [];
      if (pickupAt === undefined) {
        for (const pickup of calendar.pickups()) {
          const preview = calendar.preview(pickup);
          if (preview && available(preview, time, selectedShop.id)) {
            slots.push(preview);
          } else if (preview) {
            const [shortest] = firstAvailableReturns(calendar, preview.id, time, selectedShop.id, 1);
            if (shortest) slots.push(shortest);
          }
        }
      } else {
        slots.push(...firstAvailableReturns(calendar, pickupAt, time, selectedShop.id));
      }
      return {
        shop: selectedShop,
        category: { id: category.id, name: category.name },
        currency: 'PLN',
        slots: slots.map((slot) => ({
          ...slot,
          pickupAt: new Date(slot.pickupAt).toISOString(),
          returnAt: new Date(slot.returnAt).toISOString(),
          total: provisionalHourlyTotal(slot, category.hourlyRate),
        })),
      };
    },
    hold({ shopId, categoryId, slotId, returnAt, requestId }) {
      if (requestId !== undefined && (typeof requestId !== 'string' || !uuid.test(requestId))) {
        throw new OperationError(400, 'Nieprawidłowy identyfikator próby.');
      }
      return transaction(() => {
        const time = now();
        const retry = requestId && selectRetry.get(requestId);
        if (retry) {
          if (retry.shop_id !== shopId || retry.category_id !== categoryId ||
              new Date(retry.pickup_at).toISOString() !== slotId ||
              (returnAt !== undefined && new Date(retry.return_at).toISOString() !== returnAt)) {
            throw new OperationError(409, 'Ta próba dotyczy innego wyboru.');
          }
          return describeCheckout(retry, time, checkoutPayment.get(retry.id));
        }
        if (typeof shopId !== 'string' || categoryId !== category.id) {
          throw new OperationError(400, 'Wybierz termin i rower z aktualnej oferty.');
        }
        const { settings } = management.publicShop(shopId);
        const slot = bookingCalendar(settings, time).selection(slotId, returnAt);
        if (!slot) throw new OperationError(400, 'Wybierz termin i rower z aktualnej oferty.');
        if (!available(slot, time, shopId)) {
          throw new OperationError(409, 'Rower jest już zajęty w tym terminie.');
        }
        const id = randomUUID();
        insertCheckout.run(id, requestId ?? null, shopId, category.id, slot.pickupAt, slot.returnAt, provisionalHourlyTotal(slot, category.hourlyRate), time + holdDuration);
        return describeCheckout(checkout(id), time);
      });
    },
    checkout(id) {
      return describeCheckout(checkout(id), now(), checkoutPayment.get(id));
    },
    startPayment(id, input) {
      return transaction(() => {
        const time = now();
        const current = checkout(id);
        const payment = checkoutPayment.get(id);
        if (['confirmed', 'refund_started'].includes(current.status)) return describeCheckout(current, time, payment);
        if (current.deadline <= time) throw new OperationError(409, 'Blokada wygasła. Wybierz termin ponownie.');
        if (payment) return describeCheckout(current, time, payment);

        const { email, phone, riderHeight } = renterDetails(input);
        const paymentId = randomUUID();
        insertPayment.run(paymentId, id);
        startPayment.run(time + holdDuration, email, phone, riderHeight, management.publicShop(current.shop_id).shop.terms, time, id);
        return describeCheckout(checkout(id), time, { id: paymentId });
      });
    },
    paymentSession(id) {
      const payment = simulator.get(id);
      const current = checkout(payment.checkout_id);
      const time = now();
      const refund = simulator.refund(id);
      return {
        status: describeCheckout(current, time).status,
        total: current.total,
        currency: 'PLN',
        expiresAt: new Date(current.deadline).toISOString(),
        serverTime: new Date(time).toISOString(),
        ...(refund && { refund }),
      };
    },
    simulatePayment(id, input) {
      return transaction(() => simulator.pay(id, now(), input));
    },
    simulateRefund(id) {
      return transaction(() => simulator.startFullRefund(id, now()));
    },
    reconcilePayment(id) {
      if (typeof id !== 'string' || !uuid.test(id)) {
        throw new OperationError(400, 'Nieprawidłowy identyfikator płatności.');
      }
      return transaction(() => {
        const payment = simulator.get(id);
        const current = checkout(payment.checkout_id);
        const existing = selectBooking.get(id);
        if (existing) return { status: 'confirmed', bookingId: existing.id };
        if (current.status === 'refund_started') return { status: current.status, refundId: simulator.refund(id).id };

        const time = now();
        const expired = current.deadline <= time;
        if (!simulator.verify(id)) return { status: expired ? 'expired' : 'payment' };
        const startedRefund = simulator.refund(id);
        const originalSlot = { pickupAt: current.pickup_at, returnAt: current.return_at };
        if (startedRefund || (expired && (originalSlot.pickupAt <= time || !available(originalSlot, time, current.shop_id)))) {
          const refund = startedRefund ?? simulator.startFullRefund(id, time);
          refundCheckout.run(current.id);
          insertFailureMessage.run(id, current.email, 'Zwrot płatności za rezerwację',
            'Nie możemy zrealizować Twojej rezerwacji. Zleciliśmy pełny zwrot płatności.');
          return { status: 'refund_started', refundId: refund.id };
        }

        const bookingId = randomUUID();
        insertBooking.run(bookingId, current.id, id, time);
        verifyPayment.run(id);
        confirmCheckout.run(current.id);
        insertMessage.run(bookingId, current.email, 'Potwierdzenie rezerwacji', 'Potwierdziliśmy rezerwację ' + bookingId + '.');
        return { status: 'confirmed', bookingId };
      });
    },
    confirmation(id) {
      const message = selectMessage.get(id);
      if (!message) throw new OperationError(404, 'Brak potwierdzenia rezerwacji.');
      return message;
    },
    paymentFailure(id) {
      const message = selectFailureMessage.get(id);
      if (!message) throw new OperationError(404, 'Brak informacji o zwrocie płatności.');
      return message;
    },
    staffBookings(actor, shopId) {
      const ids = shopId === undefined ? management.shops(actor).map(({ id }) => id) : [shopId];
      if (shopId !== undefined) management.accessible(actor, shopId);
      return ids.flatMap((id) => listBookings.all(id))
        .sort((left, right) => left.pickup_at - right.pickup_at || left.booking_id.localeCompare(right.booking_id))
        .map((row) => ({
          ...describeCheckout(row, now()),
          id: row.booking_id,
          categoryName: category.name,
          email: row.email,
          phone: row.phone,
          riderHeight: row.rider_height,
        }));
    },
    close() {
      db.close();
    },
  };
}
