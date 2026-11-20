import { formatAmount, formatSlot, get, request, showError, startCountdown } from './common.js';

const id = window.location.pathname.split('/').at(-1);
const form = get('staff-renter-details');
const paymentLink = get('payment-link');
const bookingLink = get('booking-link');
let stopCountdown = () => {};
let termsVersion;

function showHeights(items) {
  const bikes = items.filter(({ kind }) => kind === 'bike')
    .flatMap(({ name, quantity }) => Array(quantity).fill(name));
  get('rider-heights').replaceChildren(...bikes.map((name, index) => {
    const row = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.htmlFor = input.id = 'height-' + index;
    label.textContent = 'Wzrost ' + (index + 1) + '. uczestnika (cm) — ' + name;
    input.type = 'number';
    input.min = 50;
    input.max = 250;
    input.required = true;
    row.append(label, input);
    return row;
  }));
}

async function load() {
  const checkout = await request('/api/staff-checkout/' + id);
  const { shop, status, items, total, currency } = checkout;
  const statuses = {
    payment: 'Płatność została rozpoczęta.',
    replaced: 'Ten link do płatności został zastąpiony. Użyj ostatniego linku od obsługi.',
    expired: 'Termin płatności minął. Skontaktuj się z punktem, aby przygotować nową rezerwację.',
    confirmed: 'Rezerwacja potwierdzona.',
    refund_started: 'Nie możemy zrealizować Twojej rezerwacji. Zleciliśmy pełny zwrot płatności.',
    cancelled: 'Rezerwacja anulowana.',
    no_show: 'Sprzęt nieodebrany.',
  };
  get('shop-name').textContent = shop.name;
  get('seller-name').textContent = shop.seller.legalName;
  get('seller-address').textContent = shop.seller.address;
  get('seller-nip').textContent = 'NIP ' + shop.seller.nip;
  get('seller').hidden = false;
  get('booking-period').textContent = formatSlot(checkout);
  get('booking-items').replaceChildren(...items.map(({ name, quantity }) => {
    const item = document.createElement('li');
    item.textContent = name + ' × ' + quantity;
    return item;
  }));
  get('total').textContent = formatAmount(total, currency);
  get('checkout-summary').hidden = false;
  get('checkout-status').textContent = statuses[status] ?? '';
  form.hidden = status !== 'held';
  paymentLink.hidden = status !== 'payment';
  stopCountdown();
  const active = status === 'held' || status === 'payment';
  get('checkout-deadline').hidden = !active;
  if (active) stopCountdown = startCountdown(get('hold-deadline'), checkout, () => load().catch(showError));
  if (status === 'held') {
    termsVersion = checkout.termsVersion;
    get('terms').textContent = checkout.terms;
    form.elements.acceptedTerms.checked = false;
    showHeights(items);
  }
  if (status === 'payment') paymentLink.href = checkout.paymentUrl;
  if (['confirmed', 'cancelled', 'no_show'].includes(status)) {
    const { bookingUrl } = await request('/api/checkouts/' + id + '/confirmation');
    bookingLink.href = bookingUrl;
    bookingLink.hidden = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  get('error').hidden = true;
  try {
    const riderHeights = Array.from(get('rider-heights').querySelectorAll('input'), (input) => input.valueAsNumber);
    const checkout = await request('/api/checkouts/' + id + '/payment', {
      riderHeights, termsVersion, acceptedTerms: form.elements.acceptedTerms.checked,
    });
    if (checkout.status === 'payment') window.location.assign(checkout.paymentUrl);
    else await load();
  } catch (error) {
    if (error.status === 409) await load().catch(showError);
    if (!form.hidden || error.status !== 409) showError(error);
  } finally {
    button.disabled = false;
  }
});

load().catch(showError);
