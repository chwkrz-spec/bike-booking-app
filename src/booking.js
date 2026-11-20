import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bookingCalendar } from './booking-calendar.js';
import { itemTotals, sameItems, selectionItems, stockForPeriod } from './cart.js';
import { openBookingCancellations } from './booking-cancellations.js';
import { openCancellationPolicies } from './cancellation-policy.js';
import { openRefunds } from './refunds.js';
import { category } from './catalog.js';
import { OperationError } from './operation-error.js';
import { createPaymentSimulator } from './payment-simulator.js';
import { openShopManagement } from './shop-management.js';
import { openWidgets } from './widgets.js';

const holdDuration = 15 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function renterDetails(input, bikeCount) {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const riderHeights = input.riderHeights === undefined ? [input.riderHeight] : input.riderHeights;
  const phoneDigits = phone.replace(/[^0-9]/g, '').length;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OperationError(400, 'Podaj prawidłowy adres e-mail.');
  }
  if (!/^\+?[0-9 ()-]+$/.test(phone) || phoneDigits < 7 || phoneDigits > 15) {
    throw new OperationError(400, 'Podaj prawidłowy numer telefonu.');
  }
  if (!Array.isArray(riderHeights) || riderHeights.length !== bikeCount ||
      riderHeights.some((height) => !Number.isInteger(height) || height < 50 || height > 250)) {
    throw new OperationError(400, 'Podaj jeden wzrost w centymetrach dla każdego roweru (50–250).');
  }
  if (input.acceptedTerms !== true) {
    throw new OperationError(400, 'Zaakceptuj warunki najmu.');
  }
  return { email, phone, riderHeights };
}

function savedItems(row) {
  return row.items ? JSON.parse(row.items) : [{
    itemId: row.category_id, name: category.name, kind: 'bike', quantity: 1, unitTotal: row.total,
  }];
}

function checkoutSummary(row, now, payment) {
  return {
    id: row.id,
    status: row.deadline <= now && ['held', 'payment'].includes(row.status) ? 'expired' : row.status,
    shopId: row.shop_id,
    categoryId: row.category_id,
    items: savedItems(row),
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
    CREATE TABLE IF NOT EXISTS checkout_carts (
      checkout_id TEXT PRIMARY KEY REFERENCES checkouts(id),
      items TEXT NOT NULL,
      rider_heights TEXT
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
    CREATE TABLE IF NOT EXISTS pickup_assignments (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      assigned_by TEXT NOT NULL,
      assigned_at INTEGER NOT NULL,
      items TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS checkout_shop_period ON checkouts(shop_id, return_at);
  `);
  const management = openShopManagement(db, { staffPassword, demoOwners });
  const refunds = openRefunds(db);
  const simulator = createPaymentSimulator(db, refunds);
  const policies = openCancellationPolicies(db, management);

  function describeCheckout(row, time, payment) {
    const summary = checkoutSummary(row, time, payment);
    if (summary.status !== 'held') return summary;
    const { terms, termsVersion } = policies.quote(row.shop_id);
    return { ...summary, terms, termsVersion };
  }
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
  const bookingRows = `
    SELECT b.id AS booking_id, b.payment_id, c.*, cart.items, cart.rider_heights,
      assignment.assigned_by, assignment.assigned_at, assignment.items AS assigned_items
    FROM bookings b JOIN checkouts c ON c.id = b.checkout_id
    LEFT JOIN checkout_carts cart ON cart.checkout_id = c.id
    LEFT JOIN pickup_assignments assignment ON assignment.booking_id = b.id
  `;
  const listBookings = db.prepare(bookingRows + ' WHERE c.shop_id = ? ORDER BY c.pickup_at, b.id');
  const selectStaffBooking = db.prepare(bookingRows + ' WHERE c.shop_id = ? AND b.id = ?');
  const recordAssignment = db.prepare('INSERT INTO pickup_assignments VALUES (?, ?, ?, ?)');
  const assignmentExists = db.prepare('SELECT 1 FROM pickup_assignments WHERE booking_id = ?');
  const confirmCheckout = db.prepare("UPDATE checkouts SET status = 'confirmed' WHERE id = ?");
  const refundCheckout = db.prepare("UPDATE checkouts SET status = 'refund_started' WHERE id = ?");
  const verifyPayment = db.prepare("UPDATE payments SET status = 'verified' WHERE id = ?");
  const selectRetry = db.prepare(`
    SELECT c.*, cart.items FROM checkouts c LEFT JOIN checkout_carts cart ON cart.checkout_id = c.id WHERE c.request_id = ?
  `);
  const checkoutPayment = db.prepare('SELECT * FROM payments WHERE checkout_id = ?');
  const insertPayment = db.prepare("INSERT INTO payments (id, checkout_id, status) VALUES (?, ?, 'pending')");
  const startPayment = db.prepare(`
    UPDATE checkouts SET status = 'payment', deadline = ?, email = ?, phone = ?, rider_height = ?,
      terms_text = ?, terms_accepted_at = ? WHERE id = ?
  `);
  const selectCheckout = db.prepare(`
    SELECT c.*, cart.items FROM checkouts c LEFT JOIN checkout_carts cart ON cart.checkout_id = c.id WHERE c.id = ?
  `);
  const occupied = db.prepare(`
    SELECT c.*, cart.items FROM checkouts c LEFT JOIN checkout_carts cart ON cart.checkout_id = c.id
    WHERE c.shop_id = ? AND c.return_at > ?
      AND (c.status = 'confirmed' OR (c.status IN ('held', 'payment') AND c.deadline > ?))
  `);
  const insertCheckout = db.prepare(`
    INSERT INTO checkouts (id, request_id, shop_id, category_id, pickup_at, return_at, total, status, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)
  `);
  const insertCart = db.prepare('INSERT INTO checkout_carts (checkout_id, items) VALUES (?, ?)');
  const recordHeights = db.prepare('UPDATE checkout_carts SET rider_heights = ? WHERE checkout_id = ?');
  const cancellations = openBookingCancellations(db, {
    policies, refunds, simulator, management, now,
    itemsForBooking: (row) => savedItems(selectCheckout.get(row.id)),
    canCancelBooking: (row) => row.status === 'confirmed' && !assignmentExists.get(row.booking_id),
  });

  function availability(shopId, inventory, timestamp, bufferMinutes = 0) {
    const commitments = occupied.all(shopId, timestamp - bufferMinutes * 60_000, timestamp).map((row) => ({
      pickupAt: row.pickup_at, returnAt: row.return_at, items: savedItems(row),
    }));
    return stockForPeriod(inventory, commitments, bufferMinutes);
  }

  function available(items, quantities) {
    return items.every(({ itemId, quantity }) => quantities[itemId] >= quantity);
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

  function pickupAssignment(row) {
    return row.assigned_items ? {
      items: JSON.parse(row.assigned_items),
      assignedBy: row.assigned_by,
      assignedAt: new Date(row.assigned_at).toISOString(),
    } : null;
  }

  function canAssignUnits(row, time) {
    return row.status === 'confirmed' && !row.assigned_items && row.pickup_at <= time && time < row.return_at;
  }

  return {
    management,
    cancellationPolicy: (actor, input) => transaction(() => policies.settings(actor, input)),
    renterBooking: cancellations.renterView,
    cancelRenterBooking: (token, input) => transaction(() => cancellations.renterCancel(token, input)),
    cancelPartnerBooking: (actor, id) => transaction(() => cancellations.partnerCancel(actor, id)),
    bookingRefunds: cancellations.staffRefunds,
    widgets: openWidgets(db),
    offer(shopId, pickupAt) {
      const time = now();
      const { shop: selectedShop, settings } = management.publicShop(shopId);
      const calendar = bookingCalendar(settings, time);
      const inventory = management.inventory(selectedShop.id);
      const quantitiesFor = availability(selectedShop.id, inventory, time, settings.turnaroundBufferMinutes);
      const bikes = inventory.filter(({ kind }) => kind === 'bike');
      const withAvailability = (slot) => slot && { ...slot, availableQuantities: quantitiesFor(slot) };
      const hasBike = (slot) => slot && bikes.some(({ id }) => slot.availableQuantities[id] > 0);
      const slots = [];
      if (pickupAt === undefined) {
        for (const pickup of calendar.pickups()) {
          const preview = calendar.preview(pickup);
          const slot = withAvailability(preview);
          if (hasBike(slot)) slots.push(slot);
          else if (preview) {
            const shortest = withAvailability(calendar.returnsFor(preview.id).next().value);
            if (hasBike(shortest)) slots.push(shortest);
          }
        }
      } else {
        for (const period of calendar.returnsFor(pickupAt)) {
          const slot = withAvailability(period);
          if (!hasBike(slot)) break;
          slots.push(slot);
        }
      }
      const { terms, termsVersion } = policies.quote(selectedShop.id);
      return {
        shop: { ...selectedShop, terms, termsVersion },
        category: { id: category.id, name: category.name },
        equipment: inventory,
        currency: 'PLN',
        slots: slots.map((slot) => {
          const totals = itemTotals(slot, inventory);
          return {
            ...slot,
            pickupAt: new Date(slot.pickupAt).toISOString(),
            returnAt: new Date(slot.returnAt).toISOString(),
            total: totals[category.id],
            itemTotals: totals,
          };
        }),
      };
    },
    hold({ shopId, categoryId, slotId, returnAt, requestId, items }) {
      if (requestId !== undefined && (typeof requestId !== 'string' || !uuid.test(requestId))) {
        throw new OperationError(400, 'Nieprawidłowy identyfikator próby.');
      }
      if (typeof shopId !== 'string') throw new OperationError(400, 'Wybierz punkt i termin z aktualnej oferty.');
      return transaction(() => {
        const time = now();
        const inventory = management.inventory(shopId);
        const selected = selectionItems(items, categoryId, inventory);
        const retry = requestId && selectRetry.get(requestId);
        if (retry) {
          if (retry.shop_id !== shopId || !sameItems(selected, savedItems(retry)) ||
              new Date(retry.pickup_at).toISOString() !== slotId ||
              (returnAt !== undefined && new Date(retry.return_at).toISOString() !== returnAt)) {
            throw new OperationError(409, 'Ta próba dotyczy innego wyboru.');
          }
          return describeCheckout(retry, time, checkoutPayment.get(retry.id));
        }
        const { settings } = management.publicShop(shopId);
        const slot = bookingCalendar(settings, time).selection(slotId, returnAt);
        if (!slot) throw new OperationError(400, 'Wybierz termin z aktualnej oferty.');
        const quantitiesFor = availability(shopId, inventory, time, settings.turnaroundBufferMinutes);
        if (!available(selected, quantitiesFor(slot))) {
          throw new OperationError(409, 'Wybrany sprzęt jest już zajęty w tym terminie.');
        }
        const id = randomUUID();
        const totals = itemTotals(slot, inventory);
        const cart = selected.map((item) => ({ ...item, unitTotal: totals[item.itemId] }));
        const total = cart.reduce((sum, item) => sum + item.quantity * item.unitTotal, 0);
        const firstBike = cart.find(({ kind }) => kind === 'bike').itemId;
        insertCheckout.run(id, requestId ?? null, shopId, firstBike, slot.pickupAt, slot.returnAt, total, time + holdDuration);
        insertCart.run(id, JSON.stringify(cart));
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
        if (['confirmed', 'cancelled', 'refund_started'].includes(current.status)) return describeCheckout(current, time, payment);
        if (current.deadline <= time) throw new OperationError(409, 'Blokada wygasła. Wybierz termin ponownie.');
        if (payment) return describeCheckout(current, time, payment);

        const bikeCount = savedItems(current).reduce((count, item) => count + (item.kind === 'bike' ? item.quantity : 0), 0);
        const { email, phone, riderHeights } = renterDetails(input, bikeCount);
        const terms = policies.accept(current, input.termsVersion);
        const paymentId = randomUUID();
        insertPayment.run(paymentId, id);
        startPayment.run(time + holdDuration, email, phone, riderHeights[0], terms, time, id);
        recordHeights.run(JSON.stringify(riderHeights), id);
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
        if (existing) return { status: current.status, bookingId: existing.id };
        if (current.status === 'refund_started') return { status: current.status, refundId: simulator.refund(id).id };

        const time = now();
        const expired = current.deadline <= time;
        if (!simulator.verify(id)) return { status: expired ? 'expired' : 'payment' };
        const startedRefund = simulator.refund(id);
        const originalSlot = { pickupAt: current.pickup_at, returnAt: current.return_at };
        const canReclaim = () => {
          const { settings } = management.publicShop(current.shop_id);
          const inventory = management.inventory(current.shop_id);
          const quantitiesFor = availability(current.shop_id, inventory, time, settings.turnaroundBufferMinutes);
          return available(savedItems(current), quantitiesFor(originalSlot));
        };
        if (startedRefund || (expired && (originalSlot.pickupAt <= time || !canReclaim()))) {
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
        const bookingUrl = cancellations.privateUrl(bookingId);
        insertMessage.run(bookingId, current.email, 'Potwierdzenie rezerwacji',
          'Potwierdziliśmy rezerwację ' + bookingId + '.\nSzczegóły i anulowanie rezerwacji: ' + bookingUrl);
        return { status: 'confirmed', bookingId };
      });
    },
    confirmation(id) {
      const message = selectMessage.get(id);
      if (!message) throw new OperationError(404, 'Brak potwierdzenia rezerwacji.');
      const bookingUrl = cancellations.privateUrl(message.bookingId);
      const content = message.content.includes(bookingUrl) ? message.content
        : message.content + '\nSzczegóły i anulowanie rezerwacji: ' + bookingUrl;
      return { ...message, bookingUrl, content };
    },
    paymentFailure(id) {
      const message = selectFailureMessage.get(id);
      if (!message) throw new OperationError(404, 'Brak informacji o zwrocie płatności.');
      return message;
    },
    assignPickup(actor, shopId, bookingId, input) {
      return transaction(() => {
        management.accessible(actor, shopId);
        const row = selectStaffBooking.get(shopId, bookingId);
        if (!row) throw new OperationError(404, 'Nie znaleziono rezerwacji.');
        const bikes = savedItems(row).filter(({ kind }) => kind === 'bike');
        const invalid = () => new OperationError(400, 'Wpisz różne oznaczenia wszystkich wydawanych rowerów (do 60 znaków).');
        if (!Array.isArray(input.items) || input.items.length !== bikes.length) throw invalid();
        const seen = new Set();
        const items = bikes.map(({ itemId, quantity }) => {
          const units = input.items.find((entry) => entry?.itemId === itemId)?.units;
          if (!Array.isArray(units) || units.length !== quantity) throw invalid();
          return {
            itemId,
            units: units.map((label) => {
              const unit = typeof label === 'string' ? label.trim() : '';
              const key = unit.toLowerCase();
              if (!unit || unit.length > 60 || seen.has(key)) throw invalid();
              seen.add(key);
              return unit;
            }),
          };
        });
        const encoded = JSON.stringify(items);
        if (row.assigned_items === encoded) return pickupAssignment(row);
        const time = now();
        if (!canAssignUnits(row, time)) {
          throw new OperationError(409, 'Rowery można przydzielić przy odbiorze, przed terminem zwrotu.');
        }
        recordAssignment.run(bookingId, actor.username, time, encoded);
        return pickupAssignment(selectStaffBooking.get(shopId, bookingId));
      });
    },
    staffBookings(actor, shopId) {
      const ids = shopId === undefined ? management.shops(actor).map(({ id }) => id) : [shopId];
      if (shopId !== undefined) management.accessible(actor, shopId);
      return ids.flatMap((id) => listBookings.all(id))
        .sort((left, right) => left.pickup_at - right.pickup_at || left.booking_id.localeCompare(right.booking_id))
        .map((row) => ({
          ...describeCheckout(row, now()),
          id: row.booking_id,
          categoryName: savedItems(row).find(({ kind }) => kind === 'bike').name,
          ...cancellations.staffSummary(actor, row),
          email: row.email,
          phone: row.phone,
          riderHeight: row.rider_height,
          riderHeights: row.rider_heights ? JSON.parse(row.rider_heights) : [row.rider_height],
          canAssignUnits: canAssignUnits(row, now()),
          pickupAssignment: pickupAssignment(row),
        }));
    },
    close() {
      db.close();
    },
  };
}
