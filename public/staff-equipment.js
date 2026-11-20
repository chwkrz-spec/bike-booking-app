import { formatInstant, request } from './common.js';

function field(form, id, name) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  label.htmlFor = input.id = id;
  label.textContent = name;
  input.required = true;
  form.append(label, input);
  return input;
}

function submit(form, text) {
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'secondary';
  button.textContent = text;
  form.append(button);
}

export function stockForms(stock, path, saves, refreshShop) {
  return stock.map(({ id, name, quantity }) => {
    const row = document.createElement('li');
    const form = document.createElement('form');
    const input = field(form, 'stock-' + id, name);
    input.type = 'number';
    input.min = 0;
    input.max = 1000;
    input.value = quantity;
    submit(form, 'Zapisz ilość');
    saves(form, async () => {
      await request(path, { itemId: id, quantity: input.valueAsNumber });
      await refreshShop();
      return 'Zapisano ilość w puli online.';
    });
    row.append(form);
    return row;
  });
}

const rateFields = {
  bike: [
    ['hourlyRate', 'Stawka godzinowa (PLN)', 0.01, true],
    ['dayRate', 'Stawka dzienna (PLN)', 0.01, false],
    ['fullDayRate', 'Stawka 24-godzinna (PLN)', 0.01, false],
  ],
  accessory: [['bookingRate', 'Stawka za sztukę na rezerwację (PLN)', 0, true]],
};

function catalogForm(item, path, saves, refreshShop) {
  const form = document.createElement('form');
  const prefix = 'catalog-' + (item?.id ?? 'new');
  form.setAttribute('aria-label', item ? 'Cennik – ' + item.name : 'Dodaj sprzęt');
  const name = field(form, prefix + '-name', 'Nazwa');
  name.maxLength = 120;
  name.value = item?.name ?? '';

  let kind;
  if (!item) {
    const label = document.createElement('label');
    kind = document.createElement('select');
    label.htmlFor = kind.id = prefix + '-kind';
    label.textContent = 'Rodzaj sprzętu';
    kind.append(new Option('Kategoria roweru', 'bike'), new Option('Akcesorium', 'accessory'));
    form.append(label, kind);
  }

  const rates = document.createElement('div');
  form.append(rates);
  const selectedKind = () => item?.kind ?? kind.value;
  function showRateFields() {
    rates.replaceChildren();
    for (const [key, label, min, required] of rateFields[selectedKind()]) {
      const input = field(rates, prefix + '-' + key, label);
      input.type = 'number';
      input.step = 0.01;
      input.min = min;
      input.max = 10000;
      input.required = required;
      if (item?.[key] != null) input.value = (item[key] / 100).toFixed(2);
    }
  }
  showRateFields();
  kind?.addEventListener('change', showRateFields);
  submit(form, item ? 'Zapisz pozycję' : 'Dodaj pozycję');
  saves(form, async () => {
    const fields = rateFields[selectedKind()].map(([key]) => {
      const input = rates.querySelector('#' + prefix + '-' + key);
      return [key, input.value === '' ? null : Math.round(input.valueAsNumber * 100)];
    });
    await request(path, { id: item?.id, kind: selectedKind(), name: name.value, ...Object.fromEntries(fields) });
    await refreshShop();
    return 'Zapisano ofertę punktu.';
  });
  return form;
}

export function catalogForms(items, path, saves, refreshShop) {
  return [...items, null].map((item) => {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = item?.name ?? 'Dodaj sprzęt';
    details.append(summary, catalogForm(item, path, saves, refreshShop));
    return details;
  });
}

export function pickupControls(booking, saves, refreshShop) {
  if (booking.pickupAssignment) {
    const summary = document.createElement('p');
    const labels = booking.pickupAssignment.items.flatMap(({ units }) => units);
    summary.textContent = 'Wydane rowery: ' + labels.join(', ');
    return summary;
  }
  if (!booking.canAssignUnits) return null;

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const form = document.createElement('form');
  summary.textContent = 'Przydziel rowery';
  details.append(summary, form);
  const bikes = booking.allocatedItems.filter(({ kind }) => kind === 'bike');
  const fields = bikes.map(({ itemId, name, quantity }) => ({
    itemId,
    inputs: Array.from({ length: quantity }, (_, index) => {
      const input = field(form, 'unit-' + booking.id + '-' + itemId + '-' + index, name + ' ' + (index + 1));
      input.maxLength = 60;
      return input;
    }),
  }));
  submit(form, 'Zapisz przydział');
  saves(form, async () => {
    const items = fields.map(({ itemId, inputs }) => ({ itemId, units: inputs.map((input) => input.value) }));
    await request('/api/staff/shops/' + booking.shopId + '/bookings/' + booking.id + '/pickup', { items });
    await refreshShop();
    return 'Zapisano wydane rowery.';
  });
  return details;
}

export function equipmentOperations(booking, stock, saves, refreshShop) {
  const controls = document.createDocumentFragment();
  const path = '/api/staff/shops/' + booking.shopId + '/bookings/' + booking.id;
  const notice = (text) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    controls.append(paragraph);
  };
  const action = (label, endpoint, confirmation, success) => {
    const form = document.createElement('form');
    submit(form, label);
    saves(form, async () => {
      if (!window.confirm(confirmation)) return;
      await request(path + endpoint, {});
      await refreshShop();
      return success;
    });
    controls.append(form);
  };

  if (booking.overdue) notice('Sprzęt po terminie zwrotu');
  if (booking.equipmentReturn) notice('Sprzęt zwrócony · ' + formatInstant(booking.equipmentReturn.returnedAt));
  if (booking.canReturn) {
    action('Potwierdź zwrot sprzętu', '/return', 'Czy cały sprzęt z rezerwacji wrócił do punktu?', 'Zapisano zwrot sprzętu.');
  }
  if (booking.canMarkNoShow) {
    action('Oznacz No-Show', '/no-show', 'Czy klient nie odebrał sprzętu? Rezerwacja zostanie zamknięta bez zwrotu przedpłaty.', 'Oznaczono No-Show.');
  }

  for (const risk of booking.atRiskItems) {
    notice('Zagrożona rezerwacja · ' + risk.name + ' · brakuje ' + risk.shortBy + ' szt.');
    const item = booking.allocatedItems.find(({ itemId }) => itemId === risk.itemId);
    const options = stock.filter(({ id, kind, quantity }) => id !== item.itemId && kind === item.kind && quantity > 0);
    if (!options.length) continue;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Uzgodnij zamiennik';
    const form = document.createElement('form');
    const id = booking.id + '-' + item.itemId;
    const label = document.createElement('label');
    const select = document.createElement('select');
    label.htmlFor = select.id = 'substitute-' + id;
    label.textContent = 'Zamiennik';
    select.replaceChildren(...options.map(({ name, id }) => new Option(name, id)));
    form.append(label, select);
    const quantity = field(form, 'substitute-quantity-' + id, 'Liczba sztuk');
    quantity.type = 'number';
    quantity.min = 1;
    quantity.max = item.quantity;
    quantity.value = risk.shortBy;
    submit(form, 'Zapisz uzgodniony zamiennik');
    saves(form, async () => {
      if (!window.confirm('Czy klient zgodził się na ten zamiennik przy tej samej cenie rezerwacji?')) return;
      await request(path + '/substitute', {
        fromItemId: item.itemId,
        toItemId: select.value,
        quantity: quantity.valueAsNumber,
        revision: booking.substitutionRevision,
      });
      await refreshShop();
      return 'Zapisano uzgodniony zamiennik.';
    });
    details.append(summary, form);
    controls.append(details);
  }
  return controls;
}
