import { OperationError } from './operation-error.js';

export function createPaymentSimulator(db) {
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
  };
}
