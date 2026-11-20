import { formatAmount, get, request, showError, startCountdown } from './common.js';

const id = window.location.pathname.split('/').at(-1);
const path = '/api/simulator/payments/' + id;
let stopCountdown = () => {};

function showStatus(checkout) {
  const payment = get('payment');
  stopCountdown();
  payment.hidden = checkout.status !== 'payment';
  if (checkout.checkoutUrl) {
    get('back').href = checkout.checkoutUrl;
    get('back').textContent = 'Wróć do rezerwacji';
  }
  if (checkout.status === 'payment') {
    get('total').textContent = formatAmount(checkout.total, checkout.currency);
    stopCountdown = startCountdown(get('payment-deadline'), checkout, () => {
      load().catch(showError);
    });
  } else {
    const messages = {
      confirmed: 'Płatność zweryfikowana',
      replaced: 'Ten link do płatności został zastąpiony. Użyj ostatniego linku od obsługi.',
      cancelled: 'Rezerwacja anulowana.',
      no_show: 'Sprzęt nieodebrany.',
      refund_started: 'Nie możemy zrealizować Twojej rezerwacji. Zleciliśmy pełny zwrot płatności.',
    };
    get('payment-status').textContent = messages[checkout.status] ?? 'Okno płatności wygasło.';
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
    await request(path + '/pay', {});
    showStatus(await request('/api/payment-notifications', { paymentId: id }));
  } catch (error) {
    showError(error);
  } finally {
    get('pay').disabled = false;
  }
});

load().catch(showError);
