import { formatAmount, formatInstant, formatSlot, get, request, showError } from './common.js';

const token = window.location.pathname.split('/').at(-1);
const path = '/api/bookings/' + token;
let expectedRefund;

function display(booking) {
  expectedRefund = booking.cancellationRefund;
  get('booking').hidden = false;
  const labels = { confirmed: 'Rezerwacja potwierdzona', cancelled: 'Rezerwacja anulowana', no_show: 'Sprzęt nieodebrany' };
  get('booking-status').textContent = labels[booking.status];
  get('booking-number').textContent = 'Numer rezerwacji ' + booking.id;
  get('shop-name').textContent = booking.shopName;
  get('rental-period').textContent = formatSlot(booking);
  get('rental-items').textContent = (booking.allocatedItems ?? booking.items).map(({ name, quantity }) => name + ' · ' + quantity + ' szt.').join(', ');
  get('rental-total').textContent = formatAmount(booking.total, booking.currency);
  get('terms').textContent = booking.terms;
  get('accepted-at').textContent = 'Data akceptacji warunków ' + formatInstant(booking.termsAcceptedAt);
  get('cancellation-cutoff').textContent = 'Pełny zwrot przy anulowaniu przed ' + formatInstant(booking.freeCancellationCutoff);
  get('cancel-booking').hidden = !booking.canCancel;
  get('refund-explanation').hidden = booking.cancellationRefund === undefined;
  get('refund-label').textContent = booking.canCancel ? 'Zwrot przy anulowaniu teraz' : 'Zwrot przedpłaty';
  if (booking.cancellationRefund !== undefined) {
    get('refund-total').textContent = formatAmount(booking.cancellationRefund, booking.currency);
  }
}

get('cancel-booking').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  get('error').hidden = true;
  try {
    display(await request(path + '/cancel', { expectedRefund }));
  } catch (error) {
    showError(error);
    if (error.status === 409) {
      try {
        display(await request(path));
      } catch (refreshError) {
        showError(refreshError);
      }
    }
  } finally {
    button.disabled = false;
  }
});

try {
  display(await request(path));
} catch (error) {
  showError(error);
} finally {
  get('loading').hidden = true;
}
