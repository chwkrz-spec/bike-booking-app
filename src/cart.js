import { provisionalHourlyTotal } from './booking-calendar.js';
import { OperationError } from './operation-error.js';

const invalidSelection = () => new OperationError(400, 'Wybierz prawidłowe ilości sprzętu i co najmniej jeden rower.');

export function selectionItems(items, categoryId, inventory) {
  const selection = items === undefined ? [{ itemId: categoryId, quantity: 1 }] : items;
  if (!Array.isArray(selection) || selection.length > inventory.length) throw invalidSelection();
  const quantities = new Map();
  for (const line of selection) {
    const { itemId, quantity } = line ?? {};
    if (!inventory.some(({ id }) => id === itemId) || quantities.has(itemId) ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw invalidSelection();
    quantities.set(itemId, quantity);
  }
  if (!inventory.some(({ id, kind }) => kind === 'bike' && quantities.has(id))) throw invalidSelection();
  return inventory.filter(({ id }) => quantities.has(id))
    .map(({ id: itemId, name, kind }) => ({ itemId, name, kind, quantity: quantities.get(itemId) }));
}

export function sameItems(left, right) {
  return left.length === right.length &&
    left.every(({ itemId, quantity }, index) => itemId === right[index].itemId && quantity === right[index].quantity);
}

export function itemTotals(slot, inventory) {
  return Object.fromEntries(inventory.map(({ id, kind, hourlyRate, bookingRate }) => [
    id, kind === 'bike' ? provisionalHourlyTotal(slot, hourlyRate) : bookingRate,
  ]));
}

export function stockForPeriod(inventory, commitments, bufferMinutes = 0) {
  const buffer = bufferMinutes * 60_000;
  const byItem = new Map(inventory.map(({ id }) => [id, []]));
  for (const { pickupAt, returnAt, items } of commitments) {
    for (const { itemId, quantity } of items) {
      byItem.get(itemId)?.push({ from: pickupAt, to: returnAt + buffer, quantity });
    }
  }

  return ({ pickupAt, returnAt }) => Object.fromEntries(inventory.map(({ id, quantity }) => {
    const events = [];
    for (const interval of byItem.get(id)) {
      if (interval.from < returnAt + buffer && interval.to > pickupAt) {
        events.push(
          { at: Math.max(pickupAt, interval.from), delta: interval.quantity },
          { at: interval.to, delta: -interval.quantity },
        );
      }
    }
    // A unit returned at the start of the next commitment is free at that instant.
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let occupied = 0;
    let peak = 0;
    for (const { delta } of events) {
      occupied += delta;
      peak = Math.max(peak, occupied);
    }
    return [id, Math.max(0, quantity - peak)];
  }));
}
