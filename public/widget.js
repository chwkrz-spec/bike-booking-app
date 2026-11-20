import { formatAmount, formatInstant, formatSlot, get, request, showError, startCountdown } from './common.js';

import { openWidgetContext } from './widget-context.js';

const widget = openWidgetContext();
const scope = widget.scope;
const checkoutKey = 'bike-checkout' + scope;
const attemptKey = 'bike-selection-attempt' + scope;
const draftKey = 'bike-checkout-draft' + scope;
const steps = ['selection', 'details', 'payment-pending', 'confirmation'];

let offer;
let returns = [];
let returnRequest = 0;
let initialQuantities;
const confirmButton = get('selection').querySelector('button');
let activeId = widget.storage.getItem(checkoutKey);
let pendingRefresh;
let stopCountdown = () => {};
let refreshing = false;
let shownTermsVersion;

function showStep(step) {
  for (const id of steps) get(id).hidden = id !== step;
  get('loading').hidden = true;
  widget.showPicker(step === 'selection');
  get('checkout-summary').hidden = !['details', 'payment-pending', 'confirmation'].includes(step);
}

function currentSlot() {
  return returns.find(({ returnAt }) => returnAt === get('return').value);
}

function selectedItems() {
  return offer.equipment.map(({ id, kind }) => ({
    itemId: id, kind, quantity: get('quantity-' + id).valueAsNumber,
  }));
}

function showPrice() {
  const slot = currentSlot();
  if (slot && initialQuantities) {
    const firstBike = offer.equipment.find(({ id, kind }) => kind === 'bike' && slot.availableQuantities[id] > 0);
    if (firstBike) get('quantity-' + firstBike.id).value = 1;
    initialQuantities = false;
  }

  for (const { id } of offer.equipment) {
    const available = slot?.availableQuantities[id] ?? 0;
    const input = get('quantity-' + id);
    input.max = available;
    input.disabled = !slot;
    get('availability-' + id).textContent = slot ? 'Dostępne: ' + available : '';
  }

  const items = selectedItems();
  const valid = slot && items.some(({ kind, quantity }) => kind === 'bike' && quantity > 0) &&
    items.every(({ itemId, quantity }) => Number.isInteger(quantity) && quantity >= 0 && quantity <= slot.availableQuantities[itemId]);
  confirmButton.disabled = !valid;
  const total = valid ? items.reduce((sum, { itemId, quantity }) => sum + slot.itemTotals[itemId] * quantity, 0) : null;
  get('selection-total').textContent = total === null ? '—' : formatAmount(total, offer.currency);
}

function buildQuantities() {
  get('equipment-quantities').replaceChildren(...offer.equipment.map(({ id, name }) => {
    const row = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    const hint = document.createElement('span');
    label.textContent = name;
    label.htmlFor = input.id = 'quantity-' + id;
    hint.id = 'availability-' + id;
    hint.className = 'hint';
    input.type = 'number';
    input.min = 0;
    input.step = 1;
    input.value = 0;
    input.required = true;
    input.setAttribute('aria-describedby', hint.id);
    row.append(label, input, hint);
    return row;
  }));
  initialQuantities = true;
}

function offerPath(pickupAt) {
  const params = new URLSearchParams();
  if (widget.shopId) params.set('shopId', widget.shopId);
  if (pickupAt) params.set('pickupAt', pickupAt);
  return widget.apiPrefix + '/offer?' + params;
}

async function loadReturns() {
  const attempt = ++returnRequest;
  const pickupAt = get('slot').value;
  confirmButton.disabled = true;
  get('return').disabled = true;
  returns = [];
  get('return').replaceChildren();
  showPrice();
  try {
    if (pickupAt) {
      const result = await request(offerPath(pickupAt));
      if (attempt !== returnRequest) return;
      returns = result.slots;
    }
    get('return').replaceChildren(...returns.map((slot) => new Option(formatInstant(slot.returnAt), slot.returnAt)));
    const preferred = offer.slots.find(({ id }) => id === pickupAt)?.returnAt;
    if (returns.some(({ returnAt }) => returnAt === preferred)) get('return').value = preferred;
    get('return').disabled = returns.length === 0;
    get('no-slots').hidden = returns.length > 0;
    showPrice();
  } catch (error) {
    if (attempt === returnRequest) showError(error);
  }
}

async function selection() {
  offer = await request(offerPath());
  get('shop-name').textContent = offer.shop.name;
  get('legal-name').textContent = offer.shop.seller.legalName;
  get('seller-address').textContent = offer.shop.seller.address;
  get('seller-nip').textContent = 'NIP ' + offer.shop.seller.nip;
  get('seller').hidden = false;
  buildQuantities();
  get('slot').replaceChildren(...offer.slots.map((slot) => new Option(formatInstant(slot.pickupAt), slot.id)));
  await loadReturns();
}

function details() {
  const values = new FormData(get('details'));
  return {
    email: values.get('email'),
    phone: values.get('phone'),
    riderHeights: values.getAll('riderHeight').map(Number),
    acceptedTerms: values.has('acceptedTerms'),
    termsVersion: shownTermsVersion,
  };
}

function renderHeightFields(items) {
  const bikes = items.filter(({ kind }) => kind === 'bike').flatMap(({ name, quantity }) =>
    Array.from({ length: quantity }, (_, index) => name + ' ' + (index + 1)));
  get('rider-heights').replaceChildren(...bikes.map((bike, index) => {
    const field = document.createElement('div');
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.textContent = bikes.length === 1 ? 'Wzrost uczestnika (cm)' : 'Wzrost uczestnika — ' + bike + ' (cm)';
    label.htmlFor = input.id = 'height-' + index;
    input.name = 'riderHeight';
    input.type = 'number';
    input.min = 50;
    input.max = 250;
    input.step = 1;
    input.required = true;
    field.append(label, input);
    return field;
  }));
}

function restoreDraft() {
  const draft = JSON.parse(widget.storage.getItem(draftKey) ?? '{}');
  const heights = draft.riderHeights ?? [draft.riderHeight];
  get('email').value = draft.email || '';
  get('phone').value = draft.phone || '';
  get('details').elements.acceptedTerms.checked = Boolean(draft.acceptedTerms) && draft.termsVersion === shownTermsVersion;
  for (const [index, input] of get('rider-heights').querySelectorAll('input').entries()) {
    input.value = heights[index] || '';
  }
}

function clearCheckout() {
  activeId = undefined;
  widget.storage.removeItem(checkoutKey);
  widget.storage.removeItem(attemptKey);
  widget.storage.removeItem(draftKey);
  get('details').reset();
}

async function showCheckout(checkout) {
  stopCountdown();
  clearInterval(pendingRefresh);
  const summary = checkout.items.map(({ name, quantity }) => name + ' × ' + quantity).join(', ');
  get('selected-slot').textContent = summary + ' · ' + formatSlot(checkout);
  get('checkout-total').textContent = formatAmount(checkout.total, checkout.currency);
  if (checkout.status === 'expired' || checkout.status === 'refund_started') {
    const message = checkout.status === 'refund_started'
      ? (await request('/api/checkouts/' + checkout.id + '/payment-failure')).content
      : 'Blokada wygasła. Wybierz termin ponownie.';
    clearCheckout();
    await selection();
    showStep('selection');
    showError(new Error(message));
  } else if (['confirmed', 'cancelled', 'no_show'].includes(checkout.status)) {
    const message = await request('/api/checkouts/' + checkout.id + '/confirmation');
    const labels = { confirmed: 'Rezerwacja potwierdzona', cancelled: 'Rezerwacja anulowana', no_show: 'Sprzęt nieodebrany' };
    get('confirmation-heading').textContent = labels[checkout.status];
    get('manage-booking').href = message.bookingUrl;
    get('booking-number').textContent = 'Numer rezerwacji ' + message.bookingId;
    get('confirmation-email').textContent = message.to;
    showStep('confirmation');
  } else if (checkout.status === 'payment') {
    get('reopen-payment').href = checkout.paymentUrl;
    showStep('payment-pending');
    stopCountdown = startCountdown(get('widget-payment-deadline'), checkout, refresh);
    pendingRefresh = setInterval(refresh, 1500);
  } else {
    renderHeightFields(checkout.items);
    get('terms').textContent = checkout.terms;
    shownTermsVersion = checkout.termsVersion;
    restoreDraft();
    showStep('details');
    stopCountdown = startCountdown(get('hold-deadline'), checkout, refresh);
  }
}

async function refresh() {
  if (!activeId || refreshing) return;
  refreshing = true;
  try {
    await showCheckout(await request('/api/checkouts/' + activeId));
  } catch (error) {
    showError(error);
  } finally {
    refreshing = false;
  }
}

function savedAttempt() {
  return JSON.parse(widget.storage.getItem(attemptKey) ?? 'null');
}

async function confirmSelection(attempt) {
  try {
    const checkout = await request(widget.apiPrefix + '/checkouts', attempt);
    activeId = checkout.id;
    widget.storage.setItem(checkoutKey, activeId);
    await showCheckout(checkout);
  } catch (error) {
    if ([400, 409].includes(error.status)) {
      widget.storage.removeItem(attemptKey);
      await selection();
    }
    showStep('selection');
    showError(error);
  }
}

get('widget-shop').addEventListener('change', async (event) => {
  widget.selectShop(event.target.value);
  get('error').hidden = true;
  get('seller').hidden = true;
  showStep(null);
  get('loading').hidden = false;
  try {
    await selection();
    showStep('selection');
  } catch (error) {
    get('loading').hidden = true;
    widget.showPicker(true);
    showError(error);
  }
});
get('slot').addEventListener('change', loadReturns);
get('return').addEventListener('change', showPrice);
get('equipment').addEventListener('input', showPrice);

get('selection').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  get('widget-shop').disabled = true;
  get('error').hidden = true;
  try {
    const slotId = get('slot').value;
    const returnAt = get('return').value;
    const items = selectedItems().filter(({ quantity }) => quantity > 0).map(({ itemId, quantity }) => ({ itemId, quantity }));
    let attempt = savedAttempt();
    if (attempt?.slotId !== slotId || attempt.shopId !== offer.shop.id || attempt.returnAt !== returnAt ||
        JSON.stringify(attempt.items) !== JSON.stringify(items)) {
      attempt = { requestId: crypto.randomUUID(), slotId, returnAt, shopId: offer.shop.id, items };
      widget.storage.setItem(attemptKey, JSON.stringify(attempt));
    }
    await confirmSelection(attempt);
  } catch (error) {
    showError(error);
  } finally {
    showPrice();
    get('widget-shop').disabled = false;
  }
});

get('details').addEventListener('input', () => {
  widget.storage.setItem(draftKey, JSON.stringify(details()));
});

get('details').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  get('error').hidden = true;
  const popup = window.open('', '_blank', 'popup,width=620,height=720');
  if (popup) popup.opener = null;
  try {
    const checkout = await request('/api/checkouts/' + activeId + '/payment', details());
    if (popup && checkout.status === 'payment') popup.location.href = checkout.paymentUrl;
    else popup?.close();
    await showCheckout(checkout);
  } catch (error) {
    popup?.close();
    if (error.status === 409) await refresh();
    showError(error);
  } finally {
    button.disabled = false;
  }
});

get('new-booking').addEventListener('click', async () => {
  clearCheckout();
  try {
    await selection();
    showStep('selection');
  } catch (error) {
    showError(error);
  }
});

try {
  await widget.load();
  await selection();
  const attempt = savedAttempt();
  if (activeId) await refresh();
  else if (attempt) await confirmSelection(attempt);
  else showStep('selection');
} catch (error) {
  get('loading').hidden = true;
  showError(error);
}
