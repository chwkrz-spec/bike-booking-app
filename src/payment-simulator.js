import { OperationError } from './operation-error.js';

const lateRefundKey = 'unfulfilled-checkout';

export function createPaymentSimulator(db, refunds) {
  const legacy = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'simulated_full_refunds'");
  if (legacy.get()) {
    db.exec(`
      INSERT OR IGNORE INTO refund_requests
        (id, payment_id, request_key, amount, original_amount, original_commission,
         platform_debit, reason, requested_at, status)
      SELECT id, payment_id, 'unfulfilled-checkout', amount, amount, (amount + 10) / 20,
        (amount + 10) / 20, 'unfulfilled-checkout', started_at, 'completed'
      FROM simulated_full_refunds
    `);
  }
  const session = db.prepare(`
    SELECT p.*, c.total, c.deadline FROM payments p
    JOIN checkouts c ON c.id = p.checkout_id WHERE p.id = ?
  `);
  const record = db.prepare(`
    UPDATE payments SET simulated_amount = ?, simulated_at = ?
    WHERE id = ? AND (simulated_amount IS NULL OR simulated_amount != ?)
  `);
  function get(id) {
    const payment = session.get(id);
    if (!payment) throw new OperationError(404, 'Nie znaleziono płatności.');
    return payment;
  }

  return {
    get,
    pay(id, time, input) {
      const payment = get(id);
      const amount = input.amount ?? payment.total;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > payment.total) {
        throw new OperationError(400, 'Nieprawidłowa kwota symulowanej płatności.');
      }
      if (payment.simulated_amount === payment.total) return { status: 'paid' };
      if (payment.deadline <= time) throw new OperationError(409, 'Okno płatności wygasło.');
      record.run(amount, time, id, payment.total);
      return { status: amount === payment.total ? 'paid' : 'partial' };
    },
    verify(id) {
      const payment = get(id);
      return payment.simulated_amount === payment.total;
    },
    refund(id) {
      const refund = refunds.getByKey(id, lateRefundKey);
      return refund && { id: refund.id, amount: refund.amount };
    },
    startFullRefund(id, time) {
      const payment = get(id);
      if (payment.status === 'verified' || payment.simulated_amount !== payment.total) {
        throw new OperationError(409, 'Brak pełnej płatności do zwrotu.');
      }
      const refund = refunds.start(payment, {
        key: lateRefundKey, amount: payment.total, reason: lateRefundKey, time,
      });
      return { id: refund.id, amount: refund.amount };
    },
  };
}
