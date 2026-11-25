const minute = 60_000;
const halfHour = 30 * minute;
const hour = 60 * minute;
const localDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localTime(timestamp) {
  const parts = Object.fromEntries(localDateTime.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  return { date: parts.year + '-' + parts.month + '-' + parts.day, day: parts.weekday.toLowerCase(), time: parts.hour + ':' + parts.minute };
}

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed % halfHour !== 0) return NaN;
  return parsed;
}

export function bookingCalendar(settings, now, channelNoticeMinutes = 30) {
  const firstPickup = now + Math.max(channelNoticeMinutes, settings.minimumNoticeMinutes) * minute;
  const lastPickup = now + settings.bookingHorizonMinutes * minute;
  const maxDuration = settings.maxRentalMinutes * minute;

  function hours({ date, day }) {
    return settings.holidayHours[date] ?? settings.weeklyHours[day];
  }

  function pricingPeriod(at) {
    const local = localTime(at);
    const open = hours(local).some(([opening, closing]) => local.time >= opening && local.time < closing);
    return { date: local.date, open };
  }

  function canPickUp(at) {
    if (!Number.isFinite(at) || at < firstPickup || at > lastPickup) return false;
    return pricingPeriod(at).open;
  }

  function canReturn(at) {
    const local = localTime(at);
    if (hours(local).some(([opening, closing]) => local.time >= opening && local.time <= closing)) return true;
    return local.time === '00:00' && hours(localTime(at - minute)).some(([, closing]) => closing === '24:00');
  }

  function period(pickupAt, returnAt) {
    if (!Number.isFinite(returnAt) || returnAt <= pickupAt || returnAt - pickupAt > maxDuration || !canReturn(returnAt)) return null;
    return { id: new Date(pickupAt).toISOString(), pickupAt, returnAt };
  }

  function* returns(pickupAt) {
    for (let end = pickupAt + halfHour; end <= pickupAt + maxDuration; end += halfHour) {
      const slot = period(pickupAt, end);
      if (slot) yield slot;
    }
  }

  function preview(pickupAt) {
    return period(pickupAt, pickupAt + hour) ?? returns(pickupAt).next().value;
  }

  return {
    *pickups() {
      for (let at = Math.ceil(firstPickup / halfHour) * halfHour; at <= lastPickup; at += halfHour) {
        if (canPickUp(at)) yield at;
      }
    },
    preview,
    pricingPeriod,
    *returnsFor(value) {
      const at = timestamp(value);
      if (canPickUp(at)) yield* returns(at);
    },
    selection(pickupValue, returnValue) {
      const pickupAt = timestamp(pickupValue);
      if (!canPickUp(pickupAt)) return null;
      return returnValue === undefined ? preview(pickupAt) : period(pickupAt, timestamp(returnValue));
    },
  };
}
