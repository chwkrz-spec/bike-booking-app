import { formatAmount, get, request, startCountdown } from './common.js';
import { setRenterLanguage, showRenterError as showError, t } from './renter-language.js';

const id = window.location.pathname.split('/').at(-1);
const path = '/api/simulator/payments/' + id;
let stopCountdown = () => {};

function showStatus(checkout) {
  setRenterLanguage(checkout.language);
  const payment = get('payment');
  stopCountdown();
  payment.hidden = checkout.status !== 'payment';
  if (checkout.checkoutUrl) {
    get('back').href = checkout.checkoutUrl;
    get('back').textContent = t('Wróć do rezerwacji', 'Return to booking');
  }
  if (checkout.status === 'payment') {
    get('total').textContent = formatAmount(checkout.total, checkout.currency);
    stopCountdown = startCountdown(get('payment-deadline'), checkout, () => {
      load().catch(showError);
    });
  } else {
    const messages = {
      confirmed: t('Płatność zweryfikowana', 'Payment verified'),
      cancelled: t('Rezerwacja anulowana.', 'Booking cancelled.'),
      no_show: t('Sprzęt nieodebrany.', 'Equipment not collected.'),
      refund_started: t('Nie możemy zrealizować Twojej rezerwacji. Zleciliśmy pełny zwrot płatności.', 'We cannot fulfil your booking. We have initiated a full refund.'),
      replaced: t('Ten link do płatności został zastąpiony. Użyj ostatniego linku od obsługi.', 'This payment link has been replaced. Use the latest link from the shop.'),
    };
    get('payment-status').textContent = messages[checkout.status] ?? t('Okno płatności wygasło.', 'The payment window has expired.');
    get('back').hidden = false;
  }
}

async function load() {
  showStatus(await request(path));
}

get('pay').addEventListener('click', async () => {
  get('error').hidden = true;
  get('pay').disabled = true;
  try {
    await request(path + '/complete', {});
    await load();
  } catch (error) {
    showError(error);
  } finally {
    get('pay').disabled = false;
  }
});

load().catch(showError);
