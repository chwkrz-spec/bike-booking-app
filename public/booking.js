import { formatAmount, formatInstant, formatSlot, get, request } from './common.js';
import { setRenterLanguage, showRenterError as showError, t } from './renter-language.js';

const token = window.location.pathname.split('/').at(-1);
const path = '/api/bookings/' + token;
let expectedRefund;

function display(booking) {
  setRenterLanguage(booking.language);
  expectedRefund = booking.cancellationRefund;
  get('booking').hidden = false;
  const labels = { confirmed: t('Rezerwacja potwierdzona', 'Booking confirmed'), cancelled: t('Rezerwacja anulowana', 'Booking cancelled'), no_show: t('Sprzęt nieodebrany', 'Equipment not collected') };
  get('booking-status').textContent = labels[booking.status];
  get('booking-number').textContent = t('Numer rezerwacji ', 'Booking reference ') + booking.id;
  get('shop-name').textContent = booking.shopName;
  get('rental-period').textContent = formatSlot(booking);
  get('rental-items').textContent = (booking.allocatedItems ?? booking.items).map(({ name, quantity }) => t(name + ' · ' + quantity + ' szt.', name + ' × ' + quantity)).join(', ');
  get('rental-total').textContent = formatAmount(booking.total, booking.currency);
  get('terms').textContent = booking.terms;
  get('accepted-at').textContent = t('Data akceptacji warunków ', 'Terms accepted on ') + formatInstant(booking.termsAcceptedAt);
  get('cancellation-cutoff').textContent = t('Pełny zwrot przy anulowaniu przed ', 'Full refund if cancelled before ') + formatInstant(booking.freeCancellationCutoff);
  get('cancel-booking').hidden = !booking.canCancel;
  get('refund-explanation').hidden = booking.cancellationRefund === undefined;
  get('refund-label').textContent = booking.canCancel ? t('Zwrot przy anulowaniu teraz', 'Refund if you cancel now') : t('Zwrot przedpłaty', 'Prepayment refund');
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
