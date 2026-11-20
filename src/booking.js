import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { category, rentalSlots, shop } from './catalog.js';
import { OperationError } from './operation-error.js';
import { createPaymentSimulator } from './payment-simulator.js';

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
    status: row.deadline <= now && row.status !== 'confirmed' ? 'expired' : row.status,
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

export function openBooking({ databasePath, now }) {
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
    CREATE INDEX IF NOT EXISTS checkout_stock ON checkouts(shop_id, category_id, pickup_at, return_at);
  `);
  const simulator = createPaymentSimulator(db);
  const selectBooking = db.prepare('SELECT * FROM bookings WHERE payment_id = ?');
  const insertBooking = db.prepare('INSERT INTO bookings VALUES (?, ?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO confirmation_messages VALUES (?, ?, ?, ?)');
  const selectMessage = db.prepare(`
    SELECT b.id AS bookingId, m.recipient AS 'to', m.subject, m.content
    FROM bookings b JOIN confirmation_messages m ON m.booking_id = b.id
    WHERE b.checkout_id = ?
  `);
  const listBookings = db.prepare(`
    SELECT b.id AS booking_id, c.* FROM bookings b JOIN checkouts c ON c.id = b.checkout_id
    ORDER BY c.pickup_at, b.id
  `);
  const confirmCheckout = db.prepare("UPDATE checkouts SET status = 'confirmed' WHERE id = ?");
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

  function available(slot, timestamp) {
    return occupied.get(shop.id, category.id, slot.returnAt, slot.pickupAt, timestamp).quantity < category.stock;
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
    offer() {
      const time = now();
      return {
        shop,
        category: { id: category.id, name: category.name },
        currency: 'PLN',
        slots: rentalSlots(time).filter((slot) => available(slot, time)).map((slot) => ({
          ...slot,
          pickupAt: new Date(slot.pickupAt).toISOString(),
          returnAt: new Date(slot.returnAt).toISOString(),
        })),
      };
    },
    hold({ shopId, categoryId, slotId, requestId }) {
      if (requestId !== undefined && (typeof requestId !== 'string' || !uuid.test(requestId))) {
        throw new OperationError(400, 'Nieprawidłowy identyfikator próby.');
      }
      return transaction(() => {
        const time = now();
        const retry = requestId && selectRetry.get(requestId);
        if (retry) {
          if (retry.shop_id !== shopId || retry.category_id !== categoryId || new Date(retry.pickup_at).toISOString() !== slotId) {
            throw new OperationError(409, 'Ta próba dotyczy innego wyboru.');
          }
          return describeCheckout(retry, time, checkoutPayment.get(retry.id));
        }
        const slot = rentalSlots(time).find(({ id }) => id === slotId);
        if (shopId !== shop.id || categoryId !== category.id || !slot) {
          throw new OperationError(400, 'Wybierz termin i rower z aktualnej oferty.');
        }
        if (!available(slot, time)) {
          throw new OperationError(409, 'Rower jest już zajęty w tym terminie.');
        }
        const id = randomUUID();
        insertCheckout.run(id, requestId ?? null, shop.id, category.id, slot.pickupAt, slot.returnAt, slot.total, time + holdDuration);
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
        if (current.status === 'confirmed') return describeCheckout(current, time, payment);
        if (current.deadline <= time) throw new OperationError(409, 'Blokada wygasła. Wybierz termin ponownie.');
        if (payment) return describeCheckout(current, time, payment);

        const { email, phone, riderHeight } = renterDetails(input);
        const paymentId = randomUUID();
        insertPayment.run(paymentId, id);
        startPayment.run(time + holdDuration, email, phone, riderHeight, shop.terms, time, id);
        return describeCheckout(checkout(id), time, { id: paymentId });
      });
    },
    paymentSession(id) {
      const payment = simulator.get(id);
      const current = checkout(payment.checkout_id);
      const time = now();
      return {
        status: describeCheckout(current, time).status,
        total: current.total,
        currency: 'PLN',
        expiresAt: new Date(current.deadline).toISOString(),
        serverTime: new Date(time).toISOString(),
      };
    },
    simulatePayment(id, input) {
      return transaction(() => simulator.pay(id, now(), input));
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

        const time = now();
        if (current.deadline <= time) return { status: 'expired' };
        if (!simulator.verify(id)) return { status: 'payment' };

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
    staffBookings() {
      return listBookings.all().map((row) => ({
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
