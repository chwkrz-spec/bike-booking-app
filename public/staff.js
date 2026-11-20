import { formatAmount, formatSlot, get, request, showError } from './common.js';

function cell(row, ...values) {
  const element = row.insertCell();
  for (const value of values) {
    const line = document.createElement('div');
    line.textContent = value;
    element.append(line);
  }
}

try {
  const bookings = await request('/api/staff/bookings');
  const list = get('reservations');
  for (const booking of bookings) {
    const row = list.insertRow();
    cell(row, formatSlot(booking));
    cell(row, booking.categoryName);
    cell(row, booking.email, booking.phone);
    cell(row, booking.riderHeight + ' cm');
    cell(row, formatAmount(booking.total, booking.currency));
    cell(row, 'Potwierdzona', booking.id);
  }
  get('list').hidden = bookings.length === 0;
  get('empty').hidden = bookings.length !== 0;
} catch (error) {
  showError(error);
}
