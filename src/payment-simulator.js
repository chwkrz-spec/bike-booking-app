import { randomUUID } from 'node:crypto';
import { OperationError } from './operation-error.js';

export function createPaymentSimulator(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS simulated_full_refunds (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
      amount INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    ) STRICT;
  `);
  const session = db.prepare(`
    SELECT p.*, c.total, c.deadline FROM payments p
    JOIN checkouts c ON c.id = p.checkout_id WHERE p.id = ?
  `);
  const record = db.prepare(`
    UPDATE payments SET simulated_amount = ?, simulated_at = ?
    WHERE id = ? AND (simulated_amount IS NULL OR simulated_amount != ?)
  `);
  const refundForPayment = db.prepare('SELECT id, amount FROM simulated_full_refunds WHERE payment_id = ?');
  const recordRefund = db.prepare(`
    INSERT INTO simulated_full_refunds (id, payment_id, amount, started_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(payment_id) DO NOTHING
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
      const refund = refundForPayment.get(id);
      return refund && { id: refund.id, amount: refund.amount };
    },
    startFullRefund(id, time) {
      const payment = get(id);
      if (payment.simulated_amount !== payment.total) {
        throw new OperationError(409, 'Brak pełnej płatności do zwrotu.');
      }
      recordRefund.run(randomUUID(), id, payment.simulated_amount, time);
      return refundForPayment.get(id);
    },
  };
}
