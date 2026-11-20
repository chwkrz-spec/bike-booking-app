export const get = (id) => document.getElementById(id);

export async function request(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

const dateTime = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw',
  dateStyle: 'short',
  timeStyle: 'short',
});
const date = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'short' });
const time = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', timeStyle: 'short' });
const offset = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', timeZoneName: 'shortOffset' });
const money = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ambiguous(value) {
  const milliseconds = value.getTime();
  const formatted = dateTime.format(value);
  return [milliseconds - 3_600_000, milliseconds + 3_600_000].some((at) => dateTime.format(at) === formatted);
}

function formatWithOffset(value, base) {
  const formatted = base.format(value);
  if (!ambiguous(value)) return formatted;
  const zone = offset.formatToParts(value).find(({ type }) => type === 'timeZoneName').value;
  return formatted + ' (' + zone + ')';
}

export const formatAmount = (amount, currency) => money.format(amount / 100) + '\u00a0' + currency;
export const formatInstant = (value) => formatWithOffset(new Date(value), dateTime);
export function formatSlot({ pickupAt, returnAt }) {
  const start = new Date(pickupAt);
  const end = new Date(returnAt);
  const endDisplay = date.format(start) === date.format(end) ? time : dateTime;
  return formatWithOffset(start, dateTime) + '–' + formatWithOffset(end, endDisplay);
}

export function startCountdown(element, checkout, onExpire) {
  element.dateTime = checkout.expiresAt;
  const remainingAtLoad = Date.parse(checkout.expiresAt) - Date.parse(checkout.serverTime);
  const loadedAt = performance.now();
  function update() {
    const remaining = Math.max(0, Math.ceil((remainingAtLoad - (performance.now() - loadedAt)) / 1000));
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    element.textContent = minutes + ':' + seconds;
    if (remaining === 0) {
      clearInterval(timer);
      onExpire();
    }
  }
  const timer = setInterval(update, 250);
  update();
  return () => clearInterval(timer);
}

export function showError(error) {
  get('error').textContent = error.message;
  get('error').hidden = false;
}
