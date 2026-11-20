import { randomBytes } from 'node:crypto';
import { OperationError } from './operation-error.js';

const linkLifetime = 24 * 60 * 60 * 1000;
const tokenPattern = /^[a-zA-Z0-9_-]{43}$/;
const missingLink = () => new OperationError(404, 'Nie znaleziono linku do dokończenia rezerwacji.');

function draftFrom(input, bikeCount) {
  const email = typeof input.email === 'string' ? input.email.trim().slice(0, 254) : '';
  const phone = typeof input.phone === 'string' ? input.phone.slice(0, 30) : '';
  const heights = Array.isArray(input.riderHeights) ? input.riderHeights : [];
  const riderHeights = Array.from({ length: bikeCount }, (_, index) =>
    Number.isSafeInteger(heights[index]) ? heights[index] : null);
  const termsVersion = typeof input.termsVersion === 'string' ? input.termsVersion.slice(0, 128) : undefined;
  return { email, phone, riderHeights, acceptedTerms: input.acceptedTerms === true, termsVersion };
}

function emailMessage(link) {
  const resumeUrl = '/checkout-resume/' + link.token;
  return {
    to: link.recipient,
    subject: 'Dokończ rezerwację roweru',
    content: 'Twój prywatny link do formularza jest ważny przez 24 godziny.\n' + resumeUrl,
    resumeUrl,
    expiresAt: new Date(link.expires_at).toISOString(),
  };
}

export function openCheckoutResumes(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkout_resume_sessions (
      id TEXT PRIMARY KEY REFERENCES checkouts(id),
      current_checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(id),
      draft TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS checkout_resume_messages (
      token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES checkout_resume_sessions(id),
      request_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      UNIQUE (session_id, request_id)
    ) STRICT;
  `);
  const currentSession = db.prepare('SELECT * FROM checkout_resume_sessions WHERE current_checkout_id = ?');
  const readSession = db.prepare('SELECT * FROM checkout_resume_sessions WHERE id = ?');
  const createSession = db.prepare('INSERT INTO checkout_resume_sessions VALUES (?, ?, ?)');
  const selectMessage = db.prepare('SELECT * FROM checkout_resume_messages WHERE session_id = ? AND request_id = ?');
  const insertMessage = db.prepare('INSERT INTO checkout_resume_messages VALUES (?, ?, ?, ?, ?)');
  const selectToken = db.prepare('SELECT * FROM checkout_resume_messages WHERE token = ?');
  const replaceCheckout = db.prepare('UPDATE checkout_resume_sessions SET current_checkout_id = ? WHERE id = ?');
  const updateDraft = db.prepare('UPDATE checkout_resume_sessions SET draft = ? WHERE id = ?');

  return {
    issue(checkoutId, input, bikeCount, time) {
      const draft = draftFrom(input, bikeCount);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email) || draft.email !== input.email.trim()) {
        throw new OperationError(400, 'Podaj prawidłowy adres e-mail.');
      }
      const session = currentSession.get(checkoutId);
      const id = session?.id ?? checkoutId;
      const existing = session && selectMessage.get(id, input.requestId);
      if (existing) return emailMessage(existing);
      const encoded = JSON.stringify(draft);
      if (session) updateDraft.run(encoded, id);
      else createSession.run(id, checkoutId, encoded);
      const link = {
        token: randomBytes(32).toString('base64url'), recipient: draft.email, expires_at: time + linkLifetime,
      };
      insertMessage.run(link.token, id, input.requestId, link.recipient, link.expires_at);
      return emailMessage(link);
    },
    save(checkoutId, input, bikeCount) {
      const session = currentSession.get(checkoutId);
      if (session) updateDraft.run(JSON.stringify(draftFrom(input, bikeCount)), session.id);
    },
    replace(sessionId, checkoutId) {
      replaceCheckout.run(checkoutId, sessionId);
    },
    read(token, time) {
      const link = tokenPattern.test(token) && selectToken.get(token);
      if (!link) throw missingLink();
      if (link.expires_at <= time) throw new OperationError(410, 'Link do dokończenia rezerwacji wygasł.');
      return readSession.get(link.session_id);
    },
  };
}
