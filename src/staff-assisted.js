import { OperationError } from './operation-error.js';

const dateTime = new Intl.DateTimeFormat('pl-PL', {
  timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'short',
});
const amount = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', currencyDisplay: 'code' });

export const staffNoticeMinutes = 15;

export function renterEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new OperationError(400, 'Podaj prawidłowy adres e-mail.');
  }
  return email;
}

export function openStaffAssisted(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_payment_links (
      checkout_id TEXT PRIMARY KEY REFERENCES checkouts(id),
      created_by TEXT NOT NULL,
      language TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL
    ) STRICT;
  `);
  const read = db.prepare('SELECT * FROM staff_payment_links WHERE checkout_id = ?');
  const insert = db.prepare('INSERT INTO staff_payment_links VALUES (?, ?, ?, ?, ?, ?)');

  const languages = () => ['pl'];
  const checkoutUrl = (id) => '/staff-checkout/' + id;

  return {
    get: (id) => read.get(id),
    checkoutUrl,
    languages,
    validateLanguage(shopId, language) {
      if (!languages(shopId).includes(language)) throw new OperationError(400, 'Ten język nie jest dostępny dla tego punktu.');
    },
    enqueue(actor, checkout, shop, email, language) {
      const items = checkout.items.map(({ name, quantity }) => name + ' × ' + quantity);
      const content = [
        shop.name,
        'Odbiór: ' + dateTime.format(new Date(checkout.pickupAt)),
        'Zwrot: ' + dateTime.format(new Date(checkout.returnAt)),
        ...items,
        'Razem: ' + amount.format(checkout.total / 100),
        'Zapłać do: ' + dateTime.format(new Date(checkout.expiresAt)) + ' (czas polski)',
        'Zapłać, aby potwierdzić: ' + checkoutUrl(checkout.id),
      ].join('\n');
      insert.run(checkout.id, actor.username, language, email, 'Opłać rezerwację rowerów', content);
    },
    delivery(checkout) {
      const { recipient: to, subject, content } = read.get(checkout.id);
      return { checkout, checkoutUrl: checkoutUrl(checkout.id), message: { to, subject, content } };
    },
  };
}
