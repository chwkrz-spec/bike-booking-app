import { randomUUID } from 'node:crypto';
import { OperationError } from './operation-error.js';

const protectedTime = 24 * 60 * 60_000;

function eligiblePerUnit(item, charge, cutoff) {
  if (item.kind === 'accessory') return charge.amount;
  let totalTime = 0;
  let refundableTime = 0;
  for (const { startsAt, endsAt } of charge.coveredPeriods) {
    const start = Date.parse(startsAt);
    const end = Date.parse(endsAt);
    totalTime += end - start;
    refundableTime += Math.max(0, end - Math.max(start, cutoff));
  }
  return totalTime ? Math.round(charge.amount * (refundableTime / totalTime)) : 0;
}

export function amountForRemoval(items, input, pickupAt) {
  if (!Array.isArray(input) || !input.length || input.length > items.length) {
    throw new OperationError(400, 'Wskaż sprzęt, który klient zostawia w punkcie.');
  }
  const quantities = new Map();
  for (const { itemId, quantity } of input.map((item) => item ?? {})) {
    const item = items.find((entry) => entry.itemId === itemId);
    if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > item.quantity || quantities.has(itemId)) {
      throw new OperationError(400, 'Podaj prawidłową liczbę zdejmowanych sztuk dla każdej pozycji.');
    }
    quantities.set(itemId, quantity);
  }

  const remaining = [];
  const eligibleCharges = [];
  for (const item of items) {
    const removed = quantities.get(item.itemId) ?? 0;
    if (item.quantity > removed) remaining.push({ ...item, quantity: item.quantity - removed });
    if (!removed) continue;
    for (const [index, charge] of (item.charges ?? []).entries()) {
      const perUnit = eligiblePerUnit(item, charge, pickupAt + protectedTime);
      if (perUnit > 0) eligibleCharges.push({
        ...charge, id: item.itemId + ':' + index, name: item.name, itemId: item.itemId,
        originalAmount: charge.amount, unitAmount: perUnit, quantity: removed, amount: perUnit * removed,
      });
    }
  }
  if (!remaining.some(({ kind }) => kind === 'bike')) {
    throw new OperationError(400, 'Zmiana wymaga pozostawienia co najmniej jednego roweru w rezerwacji.');
  }
  const removedItems = items.filter(({ itemId }) => quantities.has(itemId))
    .map(({ itemId, name, kind }) => ({ itemId, name, kind, quantity: quantities.get(itemId) }));
  return { remaining, eligibleCharges, removedItems };
}

export function selectedRefund(eligibleCharges, input) {
  if (!Array.isArray(input) || input.length > eligibleCharges.length) {
    throw new OperationError(400, 'Wybierz pozycje zwrotu z aktualnego podglądu.');
  }
  const quantities = new Map();
  for (const { id, quantity } of input.map((charge) => charge ?? {})) {
    const charge = eligibleCharges.find((entry) => entry.id === id);
    if (!charge || quantities.has(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > charge.quantity) {
      throw new OperationError(400, 'Wybierz prawidłową liczbę sztuk dla zwracanej opłaty.');
    }
    quantities.set(id, quantity);
  }
  const charges = eligibleCharges.filter(({ id }) => quantities.has(id)).map((charge) => ({
    ...charge, quantity: quantities.get(charge.id), amount: charge.unitAmount * quantities.get(charge.id),
  }));
  return { charges, amount: charges.reduce((sum, { amount }) => sum + amount, 0) };
}

export function amendedBooking(row) {
  if (!row.amendment_state) return row;
  const { items, riderHeights, pickupAt, returnAt } = JSON.parse(row.amendment_state);
  return {
    ...row, items: JSON.stringify(items), rider_heights: JSON.stringify(riderHeights),
    pickup_at: Date.parse(pickupAt), return_at: Date.parse(returnAt),
    category_id: items.find(({ kind }) => kind === 'bike').itemId,
  };
}

export function openBookingAmendments(db, refunds) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_amendments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL REFERENCES bookings(id),
      revision INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      request TEXT NOT NULL,
      details TEXT NOT NULL,
      UNIQUE (booking_id, revision)
    ) STRICT;
    CREATE VIEW IF NOT EXISTS booking_amendment_state AS
      SELECT amendment.booking_id, amendment.revision + 1 AS revision, amendment.details AS state,
        CAST(json_extract(amendment.details, '$.pickupTime') AS INTEGER) AS pickup_at,
        CAST(json_extract(amendment.details, '$.returnTime') AS INTEGER) AS return_at
      FROM booking_amendments amendment
      WHERE amendment.revision = (
        SELECT MAX(latest.revision) FROM booking_amendments latest WHERE latest.booking_id = amendment.booking_id
      );
  `);
  const find = db.prepare('SELECT * FROM booking_amendments WHERE booking_id = ? AND revision = ?');
  const list = db.prepare('SELECT * FROM booking_amendments WHERE booking_id = ? ORDER BY revision');
  const insert = db.prepare('INSERT INTO booking_amendments VALUES (?, ?, ?, ?, ?, ?, ?)');

  function describe(row, paymentId) {
    const refund = refunds.getByKey(paymentId, 'booking-amendment:' + row.id);
    return {
      id: row.id, revision: row.revision + 1,
      approvedBy: row.approved_by, approvedAt: new Date(row.approved_at).toISOString(),
      ...JSON.parse(row.details).result,
      ...(refund && { refund }),
    };
  }

  return {
    history(booking) {
      return list.all(booking.booking_id).map((row) => describe(row, booking.payment_id));
    },
    replay(booking, actor, revision, input) {
      if (!Number.isSafeInteger(revision)) return undefined;
      const previous = find.get(booking.booking_id, revision);
      if (!previous) return undefined;
      if (actor.username !== previous.approved_by || JSON.stringify(input) !== previous.request) {
        throw new OperationError(409, 'Rezerwacja została zmieniona. Sprawdź aktualne szczegóły.');
      }
      return describe(previous, booking.payment_id);
    },
    approve(booking, actor, time, revision, request, state, result, payment, amount = 0) {
      const id = randomUUID();
      insert.run(id, booking.booking_id, revision, actor.username, time, JSON.stringify(request), JSON.stringify({ ...state, pickupTime: Date.parse(state.pickupAt), returnTime: Date.parse(state.returnAt), result }));
      if (amount > 0) refunds.start(payment, {
        key: 'booking-amendment:' + id, amount, reason: 'pickup-amendment', time,
        approvedBy: actor.username, details: { charges: result.charges, amendmentId: id }, status: 'pending',
      });
      return describe(find.get(booking.booking_id, revision), booking.payment_id);
    },
  };
}

export function inferAllocationSources(original, allocation) {
  const allocatedCounts = new Map(allocation.map(({ itemId, quantity }) => [itemId, quantity]));
  const direct = [];
  const missing = [];
  for (const { itemId, kind, quantity } of original) {
    const kept = Math.min(quantity, allocatedCounts.get(itemId) ?? 0);
    if (kept) {
      direct.push({ originalItemId: itemId, itemId, quantity: kept });
      allocatedCounts.set(itemId, allocatedCounts.get(itemId) - kept);
    }
    if (kept < quantity) missing.push({ itemId, kind, quantity: quantity - kept });
  }
  const sources = [...direct];
  for (const kind of ['bike', 'accessory']) {
    const removed = missing.filter((item) => item.kind === kind);
    const substitutes = allocation.filter((item) => item.kind === kind && allocatedCounts.get(item.itemId) > 0);
    if (removed.length > 1 && substitutes.length > 1) return null;
    for (const replaced of removed) {
      for (const { itemId } of substitutes) {
        const moved = Math.min(allocatedCounts.get(itemId), replaced.quantity);
        if (!moved) continue;
        sources.push({ originalItemId: replaced.itemId, itemId, quantity: moved });
        allocatedCounts.set(itemId, allocatedCounts.get(itemId) - moved);
        replaced.quantity -= moved;
      }
    }
  }
  return sources;
}

export function removeAllocations(sources, removedItems, allocated) {
  const requested = new Map(removedItems.map(({ itemId, quantity }) => [itemId, quantity]));
  // Release a substitute first when part of its original category is kept.
  const preferred = sources.toSorted((a, b) => Number(a.originalItemId === a.itemId) - Number(b.originalItemId === b.itemId));
  const quantities = new Map();
  const remainingSources = [];
  for (const source of preferred) {
    const { originalItemId, itemId, quantity } = source;
    const remove = Math.min(quantity, requested.get(originalItemId) ?? 0);
    const keep = quantity - remove;
    requested.set(originalItemId, (requested.get(originalItemId) ?? 0) - remove);
    quantities.set(itemId, (quantities.get(itemId) ?? 0) + keep);
    if (keep) remainingSources.push({ ...source, quantity: keep });
  }
  const remaining = allocated.filter(({ itemId }) => quantities.get(itemId) > 0)
    .map((item) => ({ ...item, quantity: quantities.get(item.itemId) }));
  const released = allocated.filter(({ itemId, quantity }) => (quantities.get(itemId) ?? 0) < quantity)
    .map((item) => ({ ...item, quantity: item.quantity - (quantities.get(item.itemId) ?? 0) }));
  return { remainingSources, remaining, released };
}

export function moveAllocation(sources, fromItemId, toItemId, quantity) {
  const result = [];
  let count = quantity;
  for (const source of sources) {
    const moved = source.itemId === fromItemId ? Math.min(count, source.quantity) : 0;
    count -= moved;
    if (moved < source.quantity) result.push({ ...source, quantity: source.quantity - moved });
    if (moved) result.push({ ...source, itemId: toItemId, quantity: moved });
  }
  return result;
}
