const halfHour = 30 * 60_000;
const fullDaySteps = 48;

function buildPeriods(calendar, pickupAt) {
  const periods = [];
  return (end) => {
    while (periods.length < end) {
      const index = periods.length;
      const period = calendar.pricingPeriod(pickupAt + index * halfHour);
      const previous = periods[index - 1];
      const dayStart = period.date === previous?.date ? previous.dayStart : index;
      periods.push({ ...period, dayStart });
    }
    return periods;
  };
}

function bikePricing({ hourlyRate, dayRate, fullDayRate }, periodsFor) {
  // Work in half-grosz units. Keep the lowest cost for each parity of the
  // hourly half-hours so one rounding applies even across other rate charges.
  const best = [[{ cost: 0 }, null]];
  const extend = (winner, rate, start, parity, cost) => {
    const previous = best[start][parity];
    if (!previous || (winner && winner.cost <= previous.cost + cost)) return winner;
    return { rate, start, parity, cost: previous.cost + cost };
  };

  function pricesThrough(end) {
    const periods = periodsFor(end);
    while (best.length <= end) {
      const to = best.length;
      const at = to - 1;
      const { open, dayStart } = periods[at];
      best.push([0, 1].map((parity) => {
        if (!open) return extend(null, null, at, parity, 0);

        let winner = extend(null, 'hourly', at, 1 - parity, hourlyRate);
        if (dayRate != null) {
          for (let start = dayStart; start < to; start++) {
            winner = extend(winner, 'day', start, parity, 2 * dayRate);
          }
        }
        if (fullDayRate != null) {
          for (let start = Math.max(0, to - fullDaySteps); start < to; start++) {
            winner = extend(winner, '24-hour', start, parity, 2 * fullDayRate);
          }
        }
        return winner;
      }));
    }

    const [even, odd] = best[end];
    const evenCost = even?.cost ?? Infinity;
    const oddCost = odd ? odd.cost + hourlyRate : Infinity;
    return evenCost <= oddCost ? { parity: 0, total: evenCost / 2 } : { parity: 1, total: oddCost / 2 };
  }

  return {
    total: (end) => pricesThrough(end).total,
    segments(end) {
      let { parity } = pricesThrough(end);
      const segments = [];
      while (end > 0) {
        const state = best[end][parity];
        const { rate, start } = state;
        if (rate) segments.push({ rate, start, end });
        end = start;
        parity = state.parity;
      }
      return segments.reverse();
    },
  };
}

function appendCoverage(covered, period) {
  const last = covered.at(-1);
  if (last?.endsAt === period.startsAt) last.endsAt = period.endsAt;
  else covered.push(period);
}

export function pricingForPickup(calendar, pickupAt, inventory) {
  const periodsFor = buildPeriods(calendar, pickupAt);
  const byId = new Map(inventory.map((item) => [item.id, item]));
  const bikeRates = new Map(inventory.filter(({ kind }) => kind === 'bike')
    .map((bike) => [bike.id, bikePricing(bike, periodsFor)]));
  const endStep = (returnAt) => (returnAt - pickupAt) / halfHour;
  const iso = (step) => new Date(pickupAt + step * halfHour).toISOString();
  const interval = (start, end) => ({ startsAt: iso(start), endsAt: iso(end) });

  return {
    itemTotals(returnAt) {
      const end = endStep(returnAt);
      return Object.fromEntries(inventory.map(({ id, kind, bookingRate }) => [
        id, kind === 'bike' ? bikeRates.get(id).total(end) : bookingRate,
      ]));
    },
    cart(returnAt, selected) {
      const end = endStep(returnAt);
      return selected.map((item) => {
        const { itemId, kind } = item;
        const { hourlyRate, dayRate, fullDayRate, bookingRate } = byId.get(itemId);
        const charges = [];
        if (kind === 'accessory') {
          charges.push({ rate: 'accessory', amount: bookingRate, coveredPeriods: [interval(0, end)] });
        } else {
          let hourly;
          let hourlySteps = 0;
          const segments = bikeRates.get(itemId).segments(end);
          const periods = periodsFor(end);
          for (const { rate, start, end } of segments) {
            if (rate === 'hourly') {
              if (!hourly) {
                hourly = { rate, amount: 0, coveredPeriods: [] };
                charges.push(hourly);
              }
              hourlySteps++;
              appendCoverage(hourly.coveredPeriods, interval(start, end));
            } else if (rate === 'day') {
              const coveredPeriods = [];
              for (let step = start; step < end; step++) {
                if (periods[step].open) appendCoverage(coveredPeriods, interval(step, step + 1));
              }
              charges.push({ rate, amount: dayRate, coveredPeriods });
            } else {
              charges.push({ rate, amount: fullDayRate, coveredPeriods: [interval(start, end)] });
            }
          }
          if (hourly) hourly.amount = Math.ceil(hourlySteps / 2) * hourlyRate;
        }
        const unitTotal = charges.reduce((sum, { amount }) => sum + amount, 0);
        return { ...item, unitTotal, charges };
      });
    },
  };
}
