import { formatAmount, formatInstant, get, request, showError } from './common.js';

export function setupAssistedBooking(saves) {
  const section = get('assisted-booking');
  const form = get('staff-payment-link');
  const pickup = get('staff-pickup');
  const returns = get('staff-return');
  const quantities = get('staff-quantities');
  const recipient = get('staff-renter-email');
  const message = get('staff-message');
  const submit = form.querySelector('button');
  let shopPath;
  let offer;
  let slots = [];
  let inputs = [];
  let requestId;
  let version = 0;

  function selection() {
    const slot = slots.find(({ returnAt }) => returnAt === returns.value);
    const items = inputs.map(({ itemId, kind, input }) => ({ itemId, kind, quantity: input.valueAsNumber }));
    for (const { itemId, input, availability } of inputs) {
      const max = slot?.availableQuantities[itemId] ?? 0;
      input.max = max;
      input.disabled = !slot;
      availability.textContent = slot ? 'Dostępne: ' + max : '';
    }
    const valid = slot && items.some(({ kind, quantity }) => kind === 'bike' && quantity > 0)
      && items.every(({ itemId, quantity }) => Number.isInteger(quantity) && quantity >= 0 && quantity <= slot.availableQuantities[itemId]);
    if (!valid) return null;
    return {
      items: items.filter(({ quantity }) => quantity > 0),
      total: items.reduce((sum, { itemId, quantity }) => sum + slot.itemTotals[itemId] * quantity, 0),
    };
  }

  function showPrice() {
    const selected = selection();
    submit.disabled = !selected;
    get('staff-selection-total').textContent = selected ? formatAmount(selected.total, offer.currency) : '—';
  }

  function clearMessage() {
    requestId = undefined;
    message.hidden = true;
  }

  function equipmentInputs(equipment) {
    inputs = equipment.map(({ id, name, kind }) => {
      const input = document.createElement('input');
      input.id = 'staff-quantity-' + id;
      input.type = 'number';
      input.min = 0;
      input.value = 0;
      input.required = true;

      const label = document.createElement('label');
      label.htmlFor = input.id;
      label.textContent = name + ' (liczba sztuk)';
      const availability = document.createElement('span');
      availability.id = input.id + '-availability';
      availability.className = 'hint';
      input.setAttribute('aria-describedby', availability.id);
      const row = document.createElement('div');
      row.append(label, input, availability);
      return { itemId: id, kind, input, availability, row };
    });
    quantities.replaceChildren(...inputs.map(({ row }) => row));
  }

  async function loadReturns() {
    const current = ++version;
    const pickupAt = pickup.value;
    slots = [];
    returns.replaceChildren();
    returns.disabled = true;
    showPrice();
    if (pickupAt) {
      try {
        const result = await request(shopPath + '/assisted-offer?pickupAt=' + encodeURIComponent(pickupAt));
        if (current !== version) return;
        slots = result.slots;
      } catch (error) {
        if (current === version) showError(error);
        return;
      }
    }
    returns.replaceChildren(...slots.map(({ returnAt }) => new Option(formatInstant(returnAt), returnAt)));
    returns.disabled = slots.length === 0;
    get('staff-no-slots').hidden = slots.length > 0;
    form.hidden = pickup.options.length === 0;
    showPrice();
  }

  pickup.addEventListener('change', () => {
    clearMessage();
    loadReturns();
  });
  returns.addEventListener('change', () => {
    clearMessage();
    showPrice();
  });
  quantities.addEventListener('input', () => {
    clearMessage();
    showPrice();
  });
  recipient.addEventListener('input', clearMessage);

  saves(form, async () => {
    const selected = selection();
    if (!selected) return;
    const current = requestId ??= crypto.randomUUID();
    const result = await request(shopPath + '/payment-links', {
      requestId, slotId: pickup.value, returnAt: returns.value, items: selected.items, email: recipient.value,
    });
    if (current !== requestId) return;
    get('staff-message-recipient').textContent = result.message.to + ' · ' + result.message.subject;
    get('staff-message-content').textContent = result.message.content;
    get('staff-message-link').href = result.checkoutUrl;
    message.hidden = false;
    return 'Wysłano link do płatności w symulatorze.';
  });

  return async function refreshAssistedBooking(shopId) {
    const current = ++version;
    section.hidden = true;
    clearMessage();
    if (!shopId) return;
    shopPath = '/api/staff/shops/' + shopId;
    try {
      offer = await request(shopPath + '/assisted-offer');
      if (current !== version) return;
      form.reset();
      equipmentInputs(offer.equipment);
      pickup.replaceChildren(...offer.slots.map(({ pickupAt }) => new Option(formatInstant(pickupAt), pickupAt)));
      await loadReturns();
      if (current + 1 === version) section.hidden = false;
    } catch (error) {
      if (current === version) showError(error);
    }
  };
}
