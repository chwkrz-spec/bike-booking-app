import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bookingCalendar } from './booking-calendar.js';
import { sameItems, selectionItems, stockForPeriod } from './cart.js';
import { pricingForPickup } from './pricing.js';
import {
  amendedBooking, amountForRemoval, inferAllocationSources, moveAllocation, openBookingAmendments, removeAllocations, selectedRefund,
} from './booking-amendments.js';
import { openBookingCancellations } from './booking-cancellations.js';
import { openCancellationPolicies } from './cancellation-policy.js';
import { openRefunds } from './refunds.js';
import { category } from './catalog.js';
import { OperationError } from './operation-error.js';
import { createPaymentSimulator } from './payment-simulator.js';
import { openShopManagement } from './shop-management.js';
import { openCheckoutResumes } from './checkout-resume.js';
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

function bikeCount(row) {
  return savedItems(row).filter(({ kind }) => kind === 'bike').reduce((count, item) => count + item.quantity, 0);
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
    CREATE TABLE IF NOT EXISTS booking_substitutions (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      revision INTEGER NOT NULL,
      substituted_by TEXT NOT NULL,
      substituted_at INTEGER NOT NULL,
      items TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS booking_allocation_sources (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      entries TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS booking_returns (
      booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
      returned_by TEXT NOT NULL,
      returned_at INTEGER NOT NULL
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
  const amendments = openBookingAmendments(db, refunds);
  const simulator = createPaymentSimulator(db, refunds);
  const policies = openCancellationPolicies(db, management);
  const resumes = openCheckoutResumes(db);

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
      assignment.assigned_by, assignment.assigned_at, assignment.items AS assigned_items,
      returned.returned_by, returned.returned_at, substitute.items AS allocated_items, substitute.revision,
      amended.state AS amendment_state, amended.revision AS amendment_revision
    FROM bookings b JOIN checkouts c ON c.id = b.checkout_id
    LEFT JOIN checkout_carts cart ON cart.checkout_id = c.id
    LEFT JOIN pickup_assignments assignment ON assignment.booking_id = b.id
    LEFT JOIN booking_returns returned ON returned.booking_id = b.id
    LEFT JOIN booking_substitutions substitute ON substitute.booking_id = b.id
    LEFT JOIN booking_amendment_state amended ON amended.booking_id = b.id
  `;
  const listBookings = db.prepare(bookingRows + ' WHERE c.shop_id = ? ORDER BY c.pickup_at, b.id');
  const selectStaffBooking = db.prepare(bookingRows + ' WHERE c.shop_id = ? AND b.id = ?');
  const recordAssignment = db.prepare('INSERT INTO pickup_assignments VALUES (?, ?, ?, ?)');
  const assignmentExists = db.prepare('SELECT 1 FROM pickup_assignments WHERE booking_id = ?');

  const readAllocationSources = db.prepare('SELECT entries FROM booking_allocation_sources WHERE booking_id = ?');
  const clearAllocationSources = db.prepare('DELETE FROM booking_allocation_sources WHERE booking_id = ?');
  const saveAllocationSources = db.prepare(`
    INSERT INTO booking_allocation_sources VALUES (?, ?) ON CONFLICT(booking_id) DO UPDATE SET entries = excluded.entries
  `);
  const clearSubstitution = db.prepare('DELETE FROM booking_substitutions WHERE booking_id = ?');
  const selectSubstitution = db.prepare('SELECT items FROM booking_substitutions WHERE booking_id = ?');
  const saveSubstitution = db.prepare(`
    INSERT INTO booking_substitutions (booking_id, revision, substituted_by, substituted_at, items)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(booking_id) DO UPDATE SET
      revision = revision + 1, substituted_by = excluded.substituted_by,
      substituted_at = excluded.substituted_at, items = excluded.items
  `);
  const recordReturn = db.prepare('INSERT INTO booking_returns VALUES (?, ?, ?)');
  const openAssignments = db.prepare(bookingRows + `
    WHERE c.shop_id = ? AND c.status = 'confirmed' AND assignment.booking_id IS NOT NULL
      AND returned.booking_id IS NULL
  `);
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
    SELECT c.*, cart.items, assignment.items AS assigned_items, returned.returned_at, substitute.items AS allocated_items,
      amended.state AS amendment_state
    FROM checkouts c LEFT JOIN checkout_carts cart ON cart.checkout_id = c.id
    LEFT JOIN bookings b ON b.checkout_id = c.id
    LEFT JOIN pickup_assignments assignment ON assignment.booking_id = b.id
    LEFT JOIN booking_returns returned ON returned.booking_id = b.id
    LEFT JOIN booking_substitutions substitute ON substitute.booking_id = b.id
    LEFT JOIN booking_amendment_state amended ON amended.booking_id = b.id
    WHERE c.shop_id = ?
      AND (COALESCE(returned.returned_at, amended.return_at, c.return_at) > ?
        OR (assignment.booking_id IS NOT NULL AND returned.booking_id IS NULL))
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
    itemsForBooking: (row) => savedItems(amendedBooking({ ...selectCheckout.get(row.id), ...row })),
    allocationForBooking: (row) => {
      const substitution = selectSubstitution.get(row.booking_id);
      return substitution && JSON.parse(substitution.items);
    },
    canCancelBooking: (row) => row.status === 'confirmed' && !assignmentExists.get(row.booking_id),
  });

  function overdue(row, time) {
    return Boolean(row.assigned_items && row.returned_at === null && row.return_at <= time);
  }

  function allocatedItems(row) {
    return row.allocated_items ? JSON.parse(row.allocated_items) : savedItems(row);
  }

  function commitment(row, time) {
    return {
      pickupAt: row.pickup_at,
      returnAt: row.returned_at ?? (overdue(row, time) ? Infinity : row.return_at),
      items: allocatedItems(row),
    };
  }

  function commitments(shopId, time, bufferMinutes) {
    return occupied.all(shopId, time - bufferMinutes * 60_000, time).map(amendedBooking);
  }

  function availability(shopId, inventory, timestamp, bufferMinutes = 0, excludeCheckoutId) {
    const stockClaims = commitments(shopId, timestamp, bufferMinutes)
      .filter(({ id }) => id !== excludeCheckoutId)
      .map((row) => commitment(row, timestamp));
    return stockForPeriod(inventory, stockClaims, bufferMinutes);
  }

  function confirmedStock(shopId, time) {
    const { settings: { turnaroundBufferMinutes: bufferMinutes } } = management.publicShop(shopId);
    const inventory = management.inventory(shopId);
    const confirmed = commitments(shopId, time, bufferMinutes).filter(({ status }) => status === 'confirmed');
    return { inventory, confirmed, bufferMinutes };
  }

  function remainingPeriod(row, time) {
    return { pickupAt: Math.max(row.pickup_at, time), returnAt: row.return_at };
  }

  function riskItems(row, time, stock) {
    if (row.status !== 'confirmed' || row.assigned_items || row.return_at <= time) return [];
    const { inventory, confirmed, bufferMinutes } = stock;
    const others = confirmed.filter(({ id }) => id !== row.id).map((other) => commitment(other, time));
    const quantities = stockForPeriod(inventory, others, bufferMinutes)(remainingPeriod(row, time));
    return allocatedItems(row).filter(({ itemId, quantity }) => (quantities[itemId] ?? 0) < quantity)
      .map(({ itemId, name, quantity }) => ({ itemId, name, shortBy: quantity - (quantities[itemId] ?? 0) }));
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

  function resumeState(session, time) {
    const row = checkout(session.current_checkout_id);
    const payment = checkoutPayment.get(row.id);
    const summary = describeCheckout(row, time, payment);
    const { shop, settings } = management.publicShop(row.shop_id);
    const draft = JSON.parse(session.draft);
    const view = { checkout: summary, draft, shop };
    if (['payment', 'expired'].includes(summary.status) && payment && simulator.verify(payment.id)) {
      return { ...view, checkout: { ...summary, status: 'processing' } };
    }
    if (summary.status !== 'expired') return view;
    const calendar = bookingCalendar(settings, time);
    const slot = calendar.selection(summary.pickupAt, summary.returnAt);
    const inventory = management.inventory(row.shop_id);
    const selected = savedItems(row);
    const quantities = slot && availability(row.shop_id, inventory, time, settings.turnaroundBufferMinutes)(slot);
    if (!slot || !available(selected, quantities)) {
      return { ...view, checkout: { ...summary, status: 'unavailable', reason: 'Wybrany termin lub sprzęt nie jest już dostępny.' } };
    }
    const items = selected.map((item) => ({
      ...item, name: inventory.find(({ id }) => id === item.itemId).name,
    }));
    const cart = pricingForPickup(calendar, slot.pickupAt, inventory).cart(slot.returnAt, items);
    const total = cart.reduce((sum, item) => sum + item.quantity * item.unitTotal, 0);
    const quoteVersion = createHash('sha256').update(JSON.stringify({ id: row.id, cart })).digest('hex');
    return { ...view, checkout: { ...summary, items: cart, total, quoteVersion, status: 'reconfirm' } };
  }

  function pickupAssignment(row) {
    return row.assigned_items ? {
      items: JSON.parse(row.assigned_items),
      assignedBy: row.assigned_by,
      assignedAt: new Date(row.assigned_at).toISOString(),
    } : null;
  }

  function equipmentReturn(row) {
    return row.returned_at === null ? null : {
      returnedAt: new Date(row.returned_at).toISOString(),
      returnedBy: row.returned_by,
    };
  }

  function staffBooking(actor, shopId, bookingId) {
    management.accessible(actor, shopId);
    const row = selectStaffBooking.get(shopId, bookingId);
    if (!row) throw new OperationError(404, 'Nie znaleziono rezerwacji.');
    return amendedBooking(row);
  }

  function canAssignUnits(row, time) {
    return row.status === 'confirmed' && !row.assigned_items && row.pickup_at <= time && time < row.return_at;
  }

  function riderHeights(row) {
    return row.rider_heights ? JSON.parse(row.rider_heights) : [row.rider_height];
  }

  function checkPickupAmendment(actor, shopId, id) {
    if (!management.accessible(actor, shopId).canRefund) {
      throw new OperationError(403, 'Ta operacja wymaga uprawnień do zwrotów.');
    }
    return staffBooking(actor, shopId, id);
  }

  function allocationSources(row) {
    const saved = readAllocationSources.get(row.booking_id);
    return saved ? JSON.parse(saved.entries) : inferAllocationSources(savedItems(row), allocatedItems(row));
  }

  function pickupAmendmentPreview(row, input, time) {
    if (!canAssignUnits(row, time)) {
      throw new OperationError(409, 'Skład można zmniejszyć przy odbiorze, przed wydaniem sprzętu.');
    }
    const allocations = row.allocated_items ? allocationSources(row) : undefined;
    if (allocations === null) {
      throw new OperationError(409, 'Nie można ustalić opłaconych kategorii dla istniejących zamienników.');
    }
    const { remaining, eligibleCharges, removedItems } = amountForRemoval(savedItems(row), input.removedItems, row.pickup_at);
    const { amount, charges } = selectedRefund(eligibleCharges, input.charges ?? []);
    const allocation = allocations && removeAllocations(allocations, removedItems, allocatedItems(row));
    return {
      revision: row.amendment_revision ?? 0, substitutionRevision: row.revision ?? 0,
      remaining, eligibleCharges, removedItems, amount, charges,
      ...(allocation && { releasedItems: allocation.released }),
    };
  }

  function canChangeBooking(row, time) {
    return row.status === 'confirmed' && !row.assigned_items && time < row.pickup_at;
  }

  function bookingChangePreview(row, input, time) {
    if (!canChangeBooking(row, time)) {
      throw new OperationError(409, 'Termin lub skład można zmienić przed planowanym odbiorem.');
    }
    const inventory = management.inventory(row.shop_id);
    const { settings } = management.publicShop(row.shop_id);
    const calendar = bookingCalendar(settings, time, 15);
    const period = typeof input.returnAt === 'string' && calendar.selection(input.pickupAt, input.returnAt);
    if (!period) throw new OperationError(400, 'Wybierz termin w godzinach pracy punktu i zachowaj wymagane wyprzedzenie.');
    const selection = selectionItems(input.items, undefined, inventory);
    const quantities = availability(row.shop_id, inventory, time, settings.turnaroundBufferMinutes, row.id)(period);
    if (!available(selection, quantities)) {
      throw new OperationError(409, 'Wybrany sprzęt jest już zajęty w tym terminie.');
    }
    const items = pricingForPickup(calendar, period.pickupAt, inventory).cart(period.returnAt, selection);
    const total = items.reduce((sum, item) => sum + item.quantity * item.unitTotal, 0);
    const revision = row.amendment_revision ?? 0;
    const state = { items, pickupAt: input.pickupAt, returnAt: input.returnAt };
    const quoteVersion = createHash('sha256').update(JSON.stringify({ revision, ...state })).digest('hex');
    return { ...state, total, revision, quoteVersion, priceDifference: total - row.total, canApprove: total === row.total };
  }

  return {
    management,
    cancellationPolicy: (actor, input) => transaction(() => policies.settings(actor, input)),
    renterBooking: cancellations.renterView,
    cancelRenterBooking: (token, input) => transaction(() => cancellations.renterCancel(token, input)),
    cancelPartnerBooking: (actor, id) => transaction(() => cancellations.partnerCancel(actor, id)),
    bookingRefunds: cancellations.staffRefunds,
    markNoShow: (actor, shopId, id) => transaction(() => cancellations.markNoShow(actor, shopId, id)),
    previewPickupAmendment(actor, shopId, id, input) {
      return pickupAmendmentPreview(checkPickupAmendment(actor, shopId, id), input, now());
    },
    approvePickupAmendment(actor, shopId, id, input) {
      return transaction(() => {
        const row = checkPickupAmendment(actor, shopId, id);
        const { revision, expectedRefund, renterAgreed, removedItems, charges, substitutionRevision = 0 } = input;
        const request = {
          removedItems: removedItems?.map?.((item) => [item?.itemId, item?.quantity]),
          charges: charges?.map?.((charge) => [charge?.id, charge?.quantity]),
          expectedRefund, renterAgreed, substitutionRevision,
        };
        const previous = amendments.replay(row, actor, revision, request);
        if (previous) return previous;
        const time = now();
        const draft = pickupAmendmentPreview(row, input, time);
        if (revision !== draft.revision || substitutionRevision !== draft.substitutionRevision || expectedRefund !== draft.amount) {
          throw new OperationError(409, 'Skład lub kwota zwrotu się zmieniły. Sprawdź aktualny podgląd.');
        }
        if (renterAgreed !== true) throw new OperationError(400, 'Potwierdź uzgodnienie z klientem.');
        const heights = riderHeights(row);
        let offset = 0;
        const keptHeights = [];
        for (const item of savedItems(row).filter(({ kind }) => kind === 'bike')) {
          const kept = draft.remaining.find(({ itemId }) => itemId === item.itemId)?.quantity ?? 0;
          keptHeights.push(...heights.slice(offset, offset + kept));
          offset += item.quantity;
        }
        const state = {
          items: draft.remaining, riderHeights: keptHeights,
          pickupAt: new Date(row.pickup_at).toISOString(), returnAt: new Date(row.return_at).toISOString(),
        };
        if (row.allocated_items) {
          const allocation = removeAllocations(allocationSources(row), draft.removedItems, allocatedItems(row));
          saveSubstitution.run(id, actor.username, time, JSON.stringify(allocation.remaining));
          saveAllocationSources.run(id, JSON.stringify(allocation.remainingSources));
        }
        const result = {
          type: 'pickup-removal', removedItems: draft.removedItems, charges: draft.charges,
          ...(draft.releasedItems && { releasedItems: draft.releasedItems }),
        };
        return amendments.approve(row, actor, time, revision, request, state, result, simulator.get(row.payment_id), draft.amount);
      });
    },
    previewBookingChange(actor, shopId, id, input) {
      return bookingChangePreview(staffBooking(actor, shopId, id), input, now());
    },
    approveBookingChange(actor, shopId, id, input) {
      return transaction(() => {
        const row = staffBooking(actor, shopId, id);
        const { revision, quoteVersion, renterAgreed } = input;
        const request = {
          pickupAt: input.pickupAt, returnAt: input.returnAt,
          items: input.items?.map?.((item) => [item?.itemId, item?.quantity]),
          riderHeights: input.riderHeights, quoteVersion, renterAgreed,
        };
        const previous = amendments.replay(row, actor, revision, request);
        if (previous) return previous;

        const time = now();
        const draft = bookingChangePreview(row, input, time);
        if (revision !== draft.revision || quoteVersion !== draft.quoteVersion || !draft.canApprove) {
          throw new OperationError(409, 'Zapis wymaga aktualnego podglądu i ceny zgodnej z przedpłatą.');
        }
        if (renterAgreed !== true) throw new OperationError(400, 'Potwierdź uzgodnienie z klientem.');
        const heights = input.riderHeights ?? riderHeights(row);
        const required = draft.items.filter(({ kind }) => kind === 'bike').reduce((sum, { quantity }) => sum + quantity, 0);
        if (!Array.isArray(heights) || heights.length !== required ||
            heights.some((height) => !Number.isInteger(height) || height < 50 || height > 250)) {
          throw new OperationError(400, 'Podaj jeden wzrost w centymetrach dla każdego roweru (50–250).');
        }
        const { items, pickupAt, returnAt } = draft;
        const state = { items, pickupAt, returnAt, riderHeights: heights };
        clearSubstitution.run(id);
        clearAllocationSources.run(id);
        return amendments.approve(row, actor, time, revision, request, state, { type: 'booking-change', pickupAt, returnAt, items });
      });
    },
    simulateRefundResolution(id, input) {
      return transaction(() => refunds.resolve(id, input.status, now()));
    },
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
      let pricing;
      let quotedPickup;
      return {
        shop: { ...selectedShop, terms, termsVersion },
        category: { id: category.id, name: inventory.find(({ id }) => id === category.id).name },
        equipment: inventory,
        currency: 'PLN',
        slots: slots.map((slot) => {
          if (slot.pickupAt !== quotedPickup) {
            quotedPickup = slot.pickupAt;
            pricing = pricingForPickup(calendar, quotedPickup, inventory);
          }
          const totals = pricing.itemTotals(slot.returnAt);
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
        const calendar = bookingCalendar(settings, time);
        const slot = calendar.selection(slotId, returnAt);
        if (!slot) throw new OperationError(400, 'Wybierz termin z aktualnej oferty.');
        const quantitiesFor = availability(shopId, inventory, time, settings.turnaroundBufferMinutes);
        if (!available(selected, quantitiesFor(slot))) {
          throw new OperationError(409, 'Wybrany sprzęt jest już zajęty w tym terminie.');
        }
        const id = randomUUID();
        const cart = pricingForPickup(calendar, slot.pickupAt, inventory).cart(slot.returnAt, selected);
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
    issueResumeLink(id, input) {
      if (typeof input.requestId !== 'string' || !uuid.test(input.requestId)) {
        throw new OperationError(400, 'Nieprawidłowy identyfikator wysyłki.');
      }
      return transaction(() => {
        const time = now();
        const current = checkout(id);
        if (current.status !== 'held' || current.deadline <= time) {
          throw new OperationError(409, 'Link można wysłać w trakcie wypełniania formularza.');
        }
        return resumes.issue(id, input, bikeCount(current), time);
      });
    },
    resumeCheckout(token) {
      const time = now();
      return resumeState(resumes.read(token, time), time);
    },
    confirmResumedSelection(token, { quoteVersion }) {
      return transaction(() => {
        const time = now();
        const session = resumes.read(token, time);
        const view = resumeState(session, time);
        const current = view.checkout;
        if (current.status === 'held') return view;
        if (current.status !== 'reconfirm' || quoteVersion !== current.quoteVersion) {
          throw new OperationError(409, 'Dostępność lub cena uległa zmianie. Sprawdź aktualną ofertę.');
        }
        const id = randomUUID();
        insertCheckout.run(id, null, current.shopId, current.categoryId, Date.parse(current.pickupAt),
          Date.parse(current.returnAt), current.total, time + holdDuration);
        insertCart.run(id, JSON.stringify(current.items));
        resumes.replace(session.id, id);
        return resumeState(resumes.read(token, time), time);
      });
    },
    saveResumeDraft(id, input) {
      return transaction(() => {
        const current = checkout(id);
        if (current.status !== 'held' || current.deadline <= now()) return { saved: false };
        resumes.save(id, input, bikeCount(current));
        return { saved: true };
      });
    },
    startPayment(id, input) {
      return transaction(() => {
        const time = now();
        const current = checkout(id);
        const payment = checkoutPayment.get(id);
        if (['confirmed', 'cancelled', 'no_show', 'refund_started'].includes(current.status)) return describeCheckout(current, time, payment);
        if (current.deadline <= time) throw new OperationError(409, 'Blokada wygasła. Wybierz termin ponownie.');
        if (payment) return describeCheckout(current, time, payment);

        const { email, phone, riderHeights } = renterDetails(input, bikeCount(current));
        const terms = policies.accept(current, input.termsVersion);
        const paymentId = randomUUID();
        insertPayment.run(paymentId, id);
        startPayment.run(time + holdDuration, email, phone, riderHeights[0], terms, time, id);
        recordHeights.run(JSON.stringify(riderHeights), id);
        resumes.save(id, { ...input, email, phone, riderHeights }, bikeCount(current));
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
        const canConfirm = () => {
          const { settings } = management.publicShop(current.shop_id);
          const inventory = management.inventory(current.shop_id);
          const quantitiesFor = availability(current.shop_id, inventory, time, settings.turnaroundBufferMinutes, current.id);
          return available(savedItems(current), quantitiesFor(originalSlot));
        };
        if (startedRefund || (expired && originalSlot.pickupAt <= time) || !canConfirm()) {
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
        const row = staffBooking(actor, shopId, bookingId);
        const bikes = allocatedItems(row).filter(({ kind }) => kind === 'bike');
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
        const active = openAssignments.all(shopId).map(amendedBooking);
        const labels = new Set(active.flatMap(({ assigned_items }) =>
          JSON.parse(assigned_items).flatMap(({ units }) => units.map((unit) => unit.toLowerCase()))));
        const inventory = management.inventory(shopId);
        const physicalClaims = active.map((rental) => ({ ...commitment(rental, time), returnAt: Infinity }));
        const freeNow = stockForPeriod(inventory, physicalClaims)({ pickupAt: time, returnAt: time + 1 });
        if (!available(allocatedItems(row), freeNow) || [...seen].some((label) => labels.has(label))) {
          throw new OperationError(409, 'Sprzęt jest niedostępny lub nadal znajduje się u innego klienta.');
        }
        recordAssignment.run(bookingId, actor.username, time, encoded);
        return pickupAssignment(selectStaffBooking.get(shopId, bookingId));
      });
    },
    substituteEquipment(actor, shopId, bookingId, { fromItemId, toItemId, quantity, revision }) {
      return transaction(() => {
        const row = staffBooking(actor, shopId, bookingId);
        const time = now();
        if (revision !== (row.revision ?? 0)) {
          throw new OperationError(409, 'Rezerwacja została zmieniona. Odśwież szczegóły przed zmianą sprzętu.');
        }
        const current = allocatedItems(row);
        const stock = confirmedStock(shopId, time);
        const { inventory, bufferMinutes } = stock;
        const original = current.find(({ itemId }) => itemId === fromItemId);
        const substitute = inventory.find(({ id }) => id === toItemId);
        if (!original || !substitute || original.kind !== substitute.kind || fromItemId === toItemId ||
            !Number.isInteger(quantity) || quantity < 1 || quantity > original.quantity) {
          throw new OperationError(400, 'Wybierz zamiennik tego samego rodzaju i prawidłową liczbę sztuk.');
        }
        if (!riskItems(row, time, stock).some(({ itemId }) => itemId === fromItemId)) {
          throw new OperationError(409, 'Zamiennik można uzgodnić dla zagrożonej pozycji przed wydaniem sprzętu.');
        }

        const counts = new Map(current.map(({ itemId, quantity }) => [itemId, quantity]));
        counts.set(fromItemId, original.quantity - quantity);
        counts.set(toItemId, (counts.get(toItemId) ?? 0) + quantity);
        const quantities = availability(shopId, inventory, time, bufferMinutes, row.id)(remainingPeriod(row, time));
        if (quantities[toItemId] < counts.get(toItemId)) {
          throw new OperationError(409, 'Wybrany zamiennik jest już zajęty w tym terminie.');
        }
        const items = inventory.filter(({ id }) => counts.get(id) > 0)
          .map(({ id: itemId, name, kind }) => ({ itemId, name, kind, quantity: counts.get(itemId) }));
        const sources = allocationSources(row);
        if (sources) saveAllocationSources.run(bookingId, JSON.stringify(moveAllocation(sources, fromItemId, toItemId, quantity)));
        saveSubstitution.run(bookingId, actor.username, time, JSON.stringify(items));
        return { allocatedItems: items, substitutionRevision: revision + 1 };
      });
    },
    returnEquipment(actor, shopId, bookingId) {
      return transaction(() => {
        const row = staffBooking(actor, shopId, bookingId);
        if (row.returned_at !== null) return equipmentReturn(row);
        if (row.status !== 'confirmed' || !row.assigned_items) {
          throw new OperationError(409, 'Zwrot można odnotować po wydaniu sprzętu.');
        }
        recordReturn.run(bookingId, actor.username, now());
        return equipmentReturn(selectStaffBooking.get(shopId, bookingId));
      });
    },
    staffBookings(actor, shopId) {
      const ids = shopId === undefined ? management.shops(actor).map(({ id }) => id) : [shopId];
      if (shopId !== undefined) management.accessible(actor, shopId);
      const time = now();
      const stock = new Map(ids.map((id) => [id, confirmedStock(id, time)]));
      return ids.flatMap((id) => listBookings.all(id).map(amendedBooking))
        .sort((left, right) => left.pickup_at - right.pickup_at || left.booking_id.localeCompare(right.booking_id))
        .map((row) => ({
          ...describeCheckout(row, time),
          id: row.booking_id,
          categoryName: savedItems(row).find(({ kind }) => kind === 'bike').name,
          ...cancellations.staffSummary(actor, row, time),
          email: row.email,
          phone: row.phone,
          riderHeight: row.rider_height,
          riderHeights: riderHeights(row),
          canChangeBooking: canChangeBooking(row, time),
          canAmendAtPickup: management.accessible(actor, row.shop_id).canRefund && canAssignUnits(row, time) && (!row.allocated_items || allocationSources(row) !== null),
          amendments: amendments.history(row),
          canAssignUnits: canAssignUnits(row, time),
          pickupAssignment: pickupAssignment(row),
          canReturn: row.status === 'confirmed' && Boolean(row.assigned_items) && row.returned_at === null,
          equipmentReturn: equipmentReturn(row),
          overdue: overdue(row, time),
          atRiskItems: riskItems(row, time, stock.get(row.shop_id)),
          allocatedItems: allocatedItems(row),
          substitutionRevision: row.revision ?? 0,
        }));
    },
    close() {
      db.close();
    },
  };
}
