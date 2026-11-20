import { createHash } from 'node:crypto';
import { OperationError } from './operation-error.js';
import { validateLanguage } from './renter-language.js';

const minute = 60_000;
const defaults = { freeCancellationMinutes: 1440, lateRefundPercent: 50, noShowGraceMinutes: 30 };

const checkoutTerms = {
  staff: 'Rezerwację potwierdza płatność. Nieopłacony sprzęt wraca do puli 15 minut po wysłaniu linku. Otwarcie linku lub rozpoczęcie płatności nie zmienia terminu.',
  widget: 'Nieopłacony sprzęt wraca do puli po zakończeniu blokady wyświetlonej w formularzu lub okna rozpoczętej płatności. Prywatny link do dokończenia rezerwacji działa przez 24 godziny od wysłania i nie przedłuża blokady.',
};

const englishCheckoutTerms = {
  staff: 'Payment confirms the booking. Unpaid equipment is released 15 minutes after the link was sent. Opening the link or starting payment does not change the deadline.',
  widget: 'Unpaid equipment is released when the checkout hold or payment window ends. Your private link is valid for 24 hours after it is sent and does not extend the hold.',
};

function termsText(shop, policy, channel, language) {
  if (language === 'en') {
    return [
      shop.termsEn,
      englishCheckoutTerms[channel],
      'Cancel the entire booking using the private link in your confirmation or by contacting the seller.',
      'If more than ' + policy.freeCancellationMinutes + ' minutes remain until pickup, your full prepayment will be refunded. At or after that cutoff, the refund is ' + policy.lateRefundPercent + '%.',
      'If you have not collected your equipment within ' + policy.noShowGraceMinutes + ' minutes of your pickup time, your prepayment is non-refundable.',
      'If the seller cancels the booking, you will receive a full monetary refund.',
    ].filter(Boolean).join('\n\n');
  }
  return [
    shop.terms,
    checkoutTerms[channel],
    'Całą rezerwację możesz anulować przez prywatny link w potwierdzeniu lub kontaktując się ze sprzedawcą.',
    'Jeśli do odbioru pozostało więcej niż ' + policy.freeCancellationMinutes + ' min, otrzymasz 100% przedpłaty. Przy krótszym czasie lub dokładnie na granicy zwrot wynosi ' + policy.lateRefundPercent + '%.',
    'W razie nieodebrania sprzętu po ' + policy.noShowGraceMinutes + ' min od terminu odbioru przedpłata nie podlega zwrotowi.',
    'Gdy rezerwację anuluje sprzedawca, otrzymasz pełny zwrot pieniężny.',
  ].join('\n\n');
}

export function openCancellationPolicies(db, management) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_cancellation_policies (
      partner_id TEXT PRIMARY KEY REFERENCES partners(id),
      settings TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS cancellation_terms (
      checkout_id TEXT PRIMARY KEY REFERENCES checkouts(id),
      free_cancellation_cutoff INTEGER NOT NULL,
      late_refund_percent INTEGER NOT NULL,
      no_show_grace_minutes INTEGER NOT NULL
    ) STRICT;
  `);
  const read = db.prepare('SELECT * FROM cancellation_terms WHERE checkout_id = ?');
  const save = db.prepare('INSERT INTO cancellation_terms VALUES (?, ?, ?, ?)');

  const selectPolicy = db.prepare('SELECT settings FROM partner_cancellation_policies WHERE partner_id = ?');
  const savePolicy = db.prepare(`
    INSERT INTO partner_cancellation_policies VALUES (?, ?)
    ON CONFLICT(partner_id) DO UPDATE SET settings = excluded.settings
  `);

  function readPolicy(partnerId) {
    const saved = selectPolicy.get(partnerId);
    return saved ? JSON.parse(saved.settings) : defaults;
  }

  function quote(shopId, channel = 'widget', language = 'pl') {
    const { shop, partnerId } = management.publicShop(shopId);
    const policy = readPolicy(partnerId);
    const terms = termsText(shop, policy, channel, language);
    const termsVersion = createHash('sha256').update(terms).digest('hex');
    return { terms, termsVersion, policy };
  }

  return {
    quote,
    settings(actor, input) {
      if (actor.role !== 'owner') throw new OperationError(403, 'Ta operacja wymaga uprawnień właściciela.');
      const current = readPolicy(actor.partnerId);
      if (input === undefined) return current;
      const fields = Object.keys(input);
      const limits = { freeCancellationMinutes: 366 * 1440, lateRefundPercent: 100, noShowGraceMinutes: 366 * 1440 };
      if (!fields.length || fields.some((field) => (
        !Object.hasOwn(limits, field) || !Number.isInteger(input[field]) || input[field] < 0 || input[field] > limits[field]
      ))) {
        throw new OperationError(400, 'Nieprawidłowa polityka anulowania.');
      }

      const settings = { ...current, ...input };
      savePolicy.run(actor.partnerId, JSON.stringify(settings));
      return settings;
    },
    accept(checkout, termsVersion, channel, language) {
      validateLanguage(management.publicShop(checkout.shop_id).shop, language);
      const { terms, termsVersion: expected, policy } = quote(checkout.shop_id, channel, language);
      if (termsVersion !== undefined && termsVersion !== expected) {
        throw new OperationError(409, 'Warunki najmu się zmieniły. Zapoznaj się z nimi ponownie.');
      }
      save.run(checkout.id, checkout.pickup_at - policy.freeCancellationMinutes * minute,
        policy.lateRefundPercent, policy.noShowGraceMinutes);
      return terms;
    },
    agreed(checkout) {
      const saved = read.get(checkout.id);
      return {
        terms: checkout.terms_text,
        termsAcceptedAt: new Date(checkout.terms_accepted_at).toISOString(),
        freeCancellationCutoff: new Date(saved?.free_cancellation_cutoff ?? checkout.pickup_at - defaults.freeCancellationMinutes * minute).toISOString(),
        lateRefundPercent: saved?.late_refund_percent ?? defaults.lateRefundPercent,
        noShowGraceMinutes: saved?.no_show_grace_minutes ?? defaults.noShowGraceMinutes,
      };
    },
  };
}

export function cancellationRefund(booking, policy, time, source) {
  if (source === 'no-show') return 0;
  if (source === 'partner' || time < Date.parse(policy.freeCancellationCutoff)) return booking.total;
  return Math.round(booking.total * policy.lateRefundPercent / 100);
}
