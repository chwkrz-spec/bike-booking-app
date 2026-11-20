import { formatAmount, formatInstant, request } from './common.js';

const refundStatus = {
  pending: 'Zwrot oczekuje na potwierdzenie',
  completed: 'Zwrot potwierdzony',
  failed: 'Zwrot odrzucony · wymaga wyjaśnienia',
};
const localDateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short',
});
const localValue = (instant) => localDateTime.format(new Date(instant)).replace(' ', 'T');

function fromLocalValue(value, original) {
  if (localValue(original) === value) return original;
  const localAsUtc = Date.parse(value + 'Z');
  const choices = [1, 2].map((offset) => localAsUtc - offset * 3_600_000)
    .filter((instant) => Number.isFinite(instant) && localValue(instant) === value);
  if (choices.length > 1) throw new Error('Wybierz inną godzinę. Ta godzina występuje dwukrotnie przy zmianie czasu.');
  if (!choices.length) throw new Error('Wybierz prawidłową datę i godzinę w polskim czasie.');
  return new Date(choices[0]).toISOString();
}

function field(parent, text, type, value, attributes = {}) {
  const label = document.createElement('label');
  label.textContent = text;
  const input = Object.assign(document.createElement('input'), { type, value, required: true, ...attributes });
  label.append(input);
  parent.append(label);
  return input;
}

function submit(form, text) {
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'secondary';
  button.textContent = text;
  form.append(button);
}

function quantities(parent, items, { prefix = '', max = () => 1000, value = () => 0 } = {}) {
  const fields = items.map((item) => {
    const input = field(parent, prefix + item.name, 'number', value(item), { min: 0, max: max(item) });
    return { itemId: item.itemId, input };
  });
  return () => fields.map(({ itemId, input }) => ({ itemId, quantity: input.valueAsNumber }))
    .filter(({ quantity }) => quantity > 0);
}

function editor(title, agrees, previewLabel, confirmLabel, saves, preview, render, confirm) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = title;
  const form = document.createElement('form');
  const review = document.createElement('form');
  review.hidden = true;
  details.append(summary, form, review);

  const body = document.createElement('div');
  review.append(body);
  const approval = document.createElement('div');
  const renterAgreed = field(approval, agrees, 'checkbox', '');
  submit(approval, confirmLabel);
  review.append(approval);

  let draft;
  form.addEventListener('input', () => { review.hidden = true; });
  saves(form, async () => {
    review.hidden = true;
    draft = undefined;
    const rendered = render(body, await preview());
    draft = rendered?.approval;
    approval.hidden = !draft;
    renterAgreed.checked = false;
    review.hidden = false;
  });
  saves(review, () => draft && confirm(draft(), renterAgreed.checked));
  return { details, form, finishFields: () => submit(form, previewLabel) };
}

function pickupEditor(booking, path, money, saves, refreshShop) {
  let selected;
  const view = editor(
    'Zmień skład przy odbiorze', 'Klient zaakceptował zmianę', 'Sprawdź opłaty', 'Zatwierdź zmianę przy odbiorze',
    saves, () => request(path + '/amendment/preview', { removedItems: selected() }),
    (body, draft) => {
      body.replaceChildren();
      if (draft.releasedItems) {
        const released = document.createElement('p');
        released.textContent = 'Zwalniany sprzęt · ' + draft.releasedItems.map(({ name, quantity }) => name + ' × ' + quantity).join(', ');
        body.append(released);
      }
      const choices = draft.eligibleCharges.map(({ id, name, unitAmount, quantity, coveredPeriods }) => {
        const input = field(body, name + ' · ' + money(unitAmount) + '/szt.', 'number', 0, { min: 0, max: quantity });
        const coverage = document.createElement('small');
        coverage.textContent = coveredPeriods.map(({ startsAt, endsAt }) =>
          formatInstant(startsAt) + ' – ' + formatInstant(endsAt)).join(', ');
        body.append(coverage);
        return { id, input, unitAmount };
      });
      const total = document.createElement('output');
      total.setAttribute('aria-live', 'polite');
      const amount = () => choices.reduce((sum, { unitAmount, input }) => sum + unitAmount * (input.valueAsNumber || 0), 0);
      const update = () => { total.textContent = 'Kwota zwrotu: ' + money(amount()); };
      choices.forEach(({ input }) => input.addEventListener('input', update));
      update();
      body.append(total);
      return { approval: () => ({
        removedItems: draft.removedItems.map(({ itemId, quantity }) => ({ itemId, quantity })),
        charges: choices.map(({ id, input }) => ({ id, quantity: input.valueAsNumber })).filter(({ quantity }) => quantity > 0),
        revision: draft.revision,
        substitutionRevision: draft.substitutionRevision,
        expectedRefund: amount(),
      }) };
    },
    async (draft, renterAgreed) => {
      await request(path + '/amendment', { ...draft, renterAgreed });
      await refreshShop();
      return 'Zapisano zmianę przy odbiorze.';
    },
  );
  selected = quantities(view.form, booking.items, { prefix: 'Zdejmij – ', max: ({ quantity }) => quantity });
  view.finishFields();
  return view.details;
}

function prePickupEditor(booking, stock, path, money, saves, refreshShop) {
  let data;
  const view = editor(
    'Zmień termin lub skład', 'Klient zaakceptował termin, skład i cenę', 'Sprawdź dostępność i cenę', 'Zatwierdź zmianę rezerwacji',
    saves, () => request(path + '/change/preview', data()),
    (body, draft) => {
      const quote = document.createElement('p');
      quote.textContent = 'Dostępny sprzęt · Cena ' + money(draft.total) + ' · Przedpłata ' + money(booking.total);
      body.replaceChildren(quote);
      if (!draft.canApprove) {
        const notice = document.createElement('p');
        notice.textContent = 'Zapis zmiany wymaga ceny zgodnej z przedpłatą.';
        body.append(notice);
        return undefined;
      }
      const heights = field(body, 'Wzrosty w cm (oddzielone przecinkami, w kolejności rowerów)', 'text', booking.riderHeights.join(', '));
      return { approval: () => ({
        ...data(), revision: draft.revision, quoteVersion: draft.quoteVersion,
        riderHeights: heights.value.split(',').map((value) => Number(value.trim())),
      }) };
    },
    async (draft, renterAgreed) => {
      await request(path + '/change', { ...draft, renterAgreed });
      await refreshShop();
      return 'Zapisano zmianę rezerwacji.';
    },
  );
  const pickup = field(view.form, 'Odbiór (czas polski)', 'datetime-local', localValue(booking.pickupAt), { step: 1800 });
  const returned = field(view.form, 'Zwrot sprzętu (czas polski)', 'datetime-local', localValue(booking.returnAt), { step: 1800 });
  const counts = new Map(booking.items.map(({ itemId, quantity }) => [itemId, quantity]));
  const selected = quantities(view.form, stock.map(({ id, name }) => ({ itemId: id, name })), {
    value: ({ itemId }) => counts.get(itemId) ?? 0,
  });
  data = () => ({
    items: selected(),
    pickupAt: fromLocalValue(pickup.value, booking.pickupAt),
    returnAt: fromLocalValue(returned.value, booking.returnAt),
  });
  view.finishFields();
  return view.details;
}

export function amendmentControls(booking, stock, saves, refreshShop) {
  const controls = document.createDocumentFragment();
  const path = '/api/staff/shops/' + booking.shopId + '/bookings/' + booking.id;
  const money = (amount) => formatAmount(amount, booking.currency);
  if (booking.canChangeBooking) controls.append(prePickupEditor(booking, stock, path, money, saves, refreshShop));
  if (booking.canAmendAtPickup && booking.items.reduce((sum, { quantity }) => sum + quantity, 0) > 1) {
    controls.append(pickupEditor(booking, path, money, saves, refreshShop));
  }
  for (const amendment of booking.amendments) {
    const history = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = amendment.refund ? refundStatus[amendment.refund.status] : 'Zapisana zmiana rezerwacji';
    history.append(summary);
    const approval = document.createElement('p');
    approval.textContent = 'Zatwierdził: ' + amendment.approvedBy + ' · ' + formatInstant(amendment.approvedAt);
    history.append(approval);
    if (amendment.refund) {
      const total = document.createElement('p');
      total.textContent = 'Kwota zwrotu: ' + money(amendment.refund.amount);
      history.append(total);
      const charges = document.createElement('ul');
      for (const charge of amendment.charges) {
        const row = document.createElement('li');
        row.textContent = charge.name + ' × ' + charge.quantity + ' · ' + money(charge.amount);
        charges.append(row);
      }
      history.append(charges);
    }
    controls.append(history);
  }
  return controls;
}
