import { request } from './common.js';

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

export function stockForms(stock, path, saves) {
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
      const stock = await request(path, { itemId: id, quantity: input.valueAsNumber });
      input.value = stock.find((item) => item.id === id).quantity;
      return 'Zapisano ilość w puli online.';
    });
    row.append(form);
    return row;
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
  const bikes = booking.items.filter(({ kind }) => kind === 'bike');
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
