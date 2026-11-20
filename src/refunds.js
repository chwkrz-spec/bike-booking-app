import { randomUUID } from 'node:crypto';
import { OperationError } from './operation-error.js';

export function commission(amount) {
  return Math.round(amount / 20);
}

function describe(row) {
  return {
    id: row.id,
    paymentId: row.payment_id,
    amount: row.amount,
    originalAmount: row.original_amount,
    originalCommission: row.original_commission,
    partnerDebit: row.amount - row.platform_debit,
    platformDebit: row.platform_debit,
    reason: row.reason,
    requestedAt: new Date(row.requested_at).toISOString(),
    status: row.effective_status,
    ...(row.resolved_at !== null && { resolvedAt: new Date(row.resolved_at).toISOString() }),
    ...(row.approved_by && { approvedBy: row.approved_by }),
    ...(row.details && { details: JSON.parse(row.details) }),
  };
}

export function openRefunds(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id),
      request_key TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      original_amount INTEGER NOT NULL,
      original_commission INTEGER NOT NULL,
      platform_debit INTEGER NOT NULL,
      reason TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      approved_by TEXT,
      details TEXT,
      UNIQUE (payment_id, request_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS refund_resolutions (
      refund_id TEXT PRIMARY KEY REFERENCES refund_requests(id),
      status TEXT NOT NULL,
      resolved_at INTEGER NOT NULL
    ) STRICT;
  `);
  const projection = `
    SELECT request.*, COALESCE(resolution.status, request.status) AS effective_status,
      resolution.resolved_at
    FROM refund_requests request LEFT JOIN refund_resolutions resolution ON resolution.refund_id = request.id
  `;

  const find = db.prepare(projection + ' WHERE request.payment_id = ? AND request.request_key = ?');
  const list = db.prepare(projection + ' WHERE request.payment_id = ? ORDER BY request.rowid');
  const byId = db.prepare(projection + ' WHERE request.id = ?');
  const saveResolution = db.prepare('INSERT INTO refund_resolutions VALUES (?, ?, ?)');
  const save = db.prepare('INSERT INTO refund_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  return {
    remaining(paymentId, total) {
      return total - list.all(paymentId).reduce((sum, entry) => sum + entry.amount, 0);
    },
    resolve(id, status, time) {
      if (!['completed', 'failed'].includes(status)) throw new OperationError(400, 'Nieprawidłowy wynik zwrotu.');
      const row = byId.get(id);
      if (!row || row.reason !== 'pickup-amendment') throw new OperationError(404, 'Nie znaleziono zwrotu.');
      if (row.status !== 'pending' || !['pending', status].includes(row.effective_status)) {
        throw new OperationError(409, 'Zwrot ma już inny wynik.');
      }
      if (row.effective_status === 'pending') saveResolution.run(id, status, time);
      return describe(byId.get(id));
    },
    getByKey(paymentId, key) {
      const row = find.get(paymentId, key);
      return row && describe(row);
    },
    history(paymentId) {
      return list.all(paymentId).map(describe);
    },
    start(payment, { key, amount, reason, time, approvedBy, details, id = randomUUID(), status = 'completed' }) {
      const previous = find.get(payment.id, key);
      if (previous) return describe(previous);

      const active = list.all(payment.id);
      const previousAmount = active.reduce((sum, entry) => sum + entry.amount, 0);
      const previousDebit = active.reduce((sum, entry) => sum + entry.platform_debit, 0);
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount + previousAmount > payment.total) {
        throw new OperationError(409, 'Kwota przekracza pozostałą przedpłatę.');
      }
      const originalCommission = commission(payment.total);
      const platformDebit = commission(previousAmount + amount) - previousDebit;
      save.run(id, payment.id, key, amount, payment.total, originalCommission, platformDebit,
        reason, time, status, approvedBy ?? null, details === undefined ? null : JSON.stringify(details));
      return describe(find.get(payment.id, key));
    },
  };
}
