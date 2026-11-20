import { OperationError } from './operation-error.js';
import { renterItem, renterShop, shopLanguages, validateLanguage } from './renter-language.js';

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

export function openStaffAssisted(db, management) {
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

  const languages = (shopId) => shopLanguages(management.publicShop(shopId).shop);
  const checkoutUrl = (id) => '/staff-checkout/' + id;

  return {
    get: (id) => read.get(id),
    checkoutUrl,
    languages,
    validateLanguage(shopId, language) {
      validateLanguage(management.publicShop(shopId).shop, language);
    },
    enqueue(actor, checkout, shop, email, language) {
      const english = language === 'en';
      const shopName = renterShop(shop, language).name;
      const items = checkout.items.map((item) => {
        const { name, quantity } = renterItem(item, language);
        return name + ' × ' + quantity;
      });
      const content = [
        shopName,
        (english ? 'Pickup: ' : 'Odbiór: ') + dateTime.format(new Date(checkout.pickupAt)),
        (english ? 'Return: ' : 'Zwrot: ') + dateTime.format(new Date(checkout.returnAt)),
        ...items,
        (english ? 'Total: ' : 'Razem: ') + amount.format(checkout.total / 100),
        (english ? 'Pay by: ' : 'Zapłać do: ') + dateTime.format(new Date(checkout.expiresAt)) +
          (english ? ' (Warsaw time)' : ' (czas polski)'),
        (english ? 'Pay to confirm: ' : 'Zapłać, aby potwierdzić: ') + checkoutUrl(checkout.id),
      ].join('\n');
      const subject = english ? 'Pay to confirm your bike booking' : 'Opłać rezerwację rowerów';
      insert.run(checkout.id, actor.username, language, email, subject, content);
    },
    delivery(checkout) {
      const { recipient: to, subject, content } = read.get(checkout.id);
      return { checkout, checkoutUrl: checkoutUrl(checkout.id), message: { to, subject, content } };
    },
  };
}
