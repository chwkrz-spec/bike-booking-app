import { formatAmount, formatInstant, get, request, showError } from './common.js';

export function setupAssistedBooking(saves) {
  const section = get('assisted-booking');
  const linkToReplace = get('staff-link-to-replace');
  const language = get('staff-checkout-language');
  const form = get('staff-payment-link');
  const pickup = get('staff-pickup');
  const returns = get('staff-return');
  const quantities = get('staff-quantities');
  const recipient = get('staff-renter-email');
  const message = get('staff-message');
  const submit = form.querySelector('button');
  let shopPath;
  let offer;
  let links = [];
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

  function offerPath(pickupAt) {
    const params = new URLSearchParams();
    if (linkToReplace.value) params.set('replacing', linkToReplace.value);
    if (pickupAt) params.set('pickupAt', pickupAt);
    return shopPath + '/assisted-offer?' + params;
  }

  async function loadReturns(preferredReturn) {
    const current = ++version;
    const pickupAt = pickup.value;
    slots = [];
    returns.replaceChildren();
    returns.disabled = true;
    showPrice();
    if (pickupAt) {
      try {
        const result = await request(offerPath(pickupAt));
        if (current !== version) return;
        slots = result.slots;
      } catch (error) {
        if (current === version) showError(error);
        return;
      }
    }
    returns.replaceChildren(...slots.map(({ returnAt }) => new Option(formatInstant(returnAt), returnAt)));
    if (preferredReturn && slots.length > 0) {
      if (slots.some(({ returnAt }) => returnAt === preferredReturn)) returns.value = preferredReturn;
      else {
        returns.prepend(new Option('Wybierz nowy termin zwrotu', ''));
        returns.value = '';
      }
    }
    returns.disabled = slots.length === 0;
    const hasPickupOptions = pickup.options.length > 0;
    get('staff-no-slots').hidden = slots.length > 0 || (!pickupAt && hasPickupOptions);
    form.hidden = !hasPickupOptions;
    showPrice();
  }

  async function loadOffer(original) {
    const current = ++version;
    form.hidden = true;
    get('staff-no-slots').hidden = true;
    try {
      const result = await request(offerPath());
      if (current !== version) return;
      offer = result;
      form.reset();
      equipmentInputs(offer.equipment);
      pickup.replaceChildren(...offer.slots.map(({ pickupAt }) => new Option(formatInstant(pickupAt), pickupAt)));
      language.replaceChildren(...offer.languages.map((value) => new Option(value === 'en' ? 'Angielski' : 'Polski', value)));
      get('staff-language-controls').hidden = offer.languages.length < 2;
      submit.textContent = original ? 'Wyślij poprawiony link' : 'Wyślij link do płatności';
      if (original) {
        if (offer.slots.some(({ pickupAt }) => pickupAt === original.pickupAt)) pickup.value = original.pickupAt;
        else if (offer.slots.length > 0) {
          pickup.prepend(new Option('Wybierz nowy termin odbioru', ''));
          pickup.value = '';
        }
        recipient.value = original.email;
        if (offer.languages.includes(original.language)) language.value = original.language;
        for (const { itemId, input } of inputs) {
          input.value = original.items.find((item) => item.itemId === itemId)?.quantity ?? 0;
        }
      }
      await loadReturns(original?.returnAt);
    } catch (error) {
      if (current === version) showError(error);
    }
  }

  async function loadLinks() {
    const current = ++version;
    const result = await request(shopPath + '/payment-links');
    if (current !== version) return false;
    links = result;
    linkToReplace.replaceChildren(new Option('Nowa rezerwacja', ''), ...links.map((link) => {
      const status = link.status === 'expired' ? ' · Termin płatności minął' : '';
      return new Option(formatInstant(link.pickupAt) + ' · ' + link.email + status, link.id);
    }));
    get('staff-link-controls').hidden = links.length === 0;
    return true;
  }

  linkToReplace.addEventListener('change', () => {
    clearMessage();
    loadOffer(links.find(({ id }) => id === linkToReplace.value));
  });
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
  language.addEventListener('change', clearMessage);

  saves(form, async () => {
    const selected = selection();
    if (!selected) return;
    const current = requestId ??= crypto.randomUUID();
    const replacingId = linkToReplace.value;
    const path = shopPath + '/payment-links' + (replacingId ? '/' + replacingId + '/replace' : '');
    const result = await request(path, {
      requestId, slotId: pickup.value, returnAt: returns.value, items: selected.items,
      email: recipient.value, language: language.value,
    });
    if (current !== requestId) return;
    get('staff-message-recipient').textContent = result.message.to + ' · ' + result.message.subject;
    get('staff-message-content').textContent = result.message.content;
    get('staff-message-link').href = result.checkoutUrl;
    message.hidden = false;
    if (await loadLinks()) await loadOffer();
    if (current !== requestId) return;
    requestId = undefined;
    return replacingId ? 'Wysłano poprawiony link do płatności w symulatorze.' : 'Wysłano link do płatności w symulatorze.';
  });

  return async function refreshAssistedBooking(shopId) {
    ++version;
    section.hidden = true;
    clearMessage();
    if (!shopId) return;
    shopPath = '/api/staff/shops/' + shopId;
    try {
      if (!await loadLinks()) return;
      section.hidden = false;
      await loadOffer();
    } catch (error) {
      showError(error);
    }
  };
}
