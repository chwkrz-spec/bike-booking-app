import { formatAmount, formatInstant, get, request, showError } from './common.js';

const form = get('dashboard-filters');
const shop = get('dashboard-shop');
const results = get('dashboard-results');
const submit = form.querySelector('button');
const labels = { confirmed: 'Potwierdzone', cancelled: 'Anulowane', no_show: 'No-Show' };

function showShops(shops) {
  const selected = shop.value;
  const options = shops.map(({ id, name }) => new Option(name, id));
  shop.replaceChildren(new Option('Wszystkie punkty', ''), ...options);
  shop.value = selected;
}

function showCounts(counts) {
  const table = get('dashboard-counts');
  table.replaceChildren();
  for (const [key, status] of Object.entries(labels)) {
    const { widget, staff } = counts[key];
    const row = table.insertRow();
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = status;
    row.append(heading);
    for (const value of [widget, staff, widget + staff]) row.insertCell().textContent = value;
  }
}

function showOperations(id, operations) {
  const list = get(id);
  list.replaceChildren();
  get(id + '-empty').hidden = operations.length > 0;
  for (const { scheduledAt, shopName, items, bookingId } of operations) {
    const entry = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = scheduledAt;
    time.textContent = formatInstant(scheduledAt);
    const details = document.createElement('p');
    details.textContent = shopName + ' · ' + items.map(({ name, quantity }) => name + ' × ' + quantity).join(', ');
    const reference = document.createElement('small');
    reference.textContent = bookingId;
    entry.append(time, details, reference);
    list.append(entry);
  }
}

async function refresh() {
  submit.disabled = true;
  get('error').hidden = true;
  results.setAttribute('aria-busy', 'true');
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (value) params.set(name, value);
  }
  try {
    const { shops, counts, pickups, returns, finances } = await request('/api/staff/owner-dashboard?' + params);
    showShops(shops);
    showCounts(counts);
    showOperations('dashboard-pickups', pickups);
    showOperations('dashboard-returns', returns);
    get('dashboard-collected').textContent = formatAmount(finances.collected, finances.currency);
    get('dashboard-refunded').textContent = formatAmount(finances.refunded, finances.currency);
    results.hidden = false;
  } catch (error) {
    results.hidden = true;
    showError(error);
  } finally {
    results.setAttribute('aria-busy', 'false');
    submit.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  refresh();
});
await refresh();
