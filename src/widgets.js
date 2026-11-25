import { randomUUID } from 'node:crypto';
import { OperationError } from './operation-error.js';

const modes = new Set(['inline', 'popup', 'hosted']);
const defaults = { logoUrl: '', accentColor: '#143b35', backgroundColor: '#f1f5ee' };
const color = /^#[0-9a-f]{6}$/i;

const missing = () => new OperationError(404, 'Nie znaleziono widżetu lub punktu.');
const invalidBranding = () => new OperationError(400, 'Podaj adres HTTPS logo i dwa kolory w formacie #RRGGBB.');

function owner(actor) {
  if (actor.role !== 'owner') throw new OperationError(403, 'Ta operacja wymaga uprawnień właściciela.');
}

function brandingValues({ logoUrl, accentColor, backgroundColor }) {
  if (typeof logoUrl !== 'string' || logoUrl.length > 2048 ||
      typeof accentColor !== 'string' || !color.test(accentColor) ||
      typeof backgroundColor !== 'string' || !color.test(backgroundColor)) throw invalidBranding();
  if (logoUrl) {
    const url = URL.parse(logoUrl);
    if (url?.protocol !== 'https:' || url.username || url.password) throw invalidBranding();
  }
  return { logoUrl, accentColor, backgroundColor };
}

export function openWidgets(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS widget_branding (
      partner_id TEXT PRIMARY KEY REFERENCES partners(id),
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS widgets (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL REFERENCES partners(id),
      name TEXT NOT NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('inline', 'popup', 'hosted')),
      shop_id TEXT REFERENCES shops(id)
    ) STRICT;
  `);
  const brand = db.prepare('SELECT value FROM widget_branding WHERE partner_id = ?');
  const saveBrand = db.prepare(`
    INSERT INTO widget_branding VALUES (?, ?)
    ON CONFLICT (partner_id) DO UPDATE SET value = excluded.value
  `);
  const insertWidget = db.prepare('INSERT INTO widgets VALUES (?, ?, ?, ?, ?)');
  const selectWidget = db.prepare('SELECT * FROM widgets WHERE id = ?');
  const listWidgets = db.prepare(`
    SELECT id, name, delivery, shop_id AS shopId FROM widgets WHERE partner_id = ? ORDER BY name, id
  `);
  const listShops = db.prepare('SELECT id, name FROM shops WHERE partner_id = ? ORDER BY name, id');

  function readBrand(partnerId) {
    const row = brand.get(partnerId);
    return row ? JSON.parse(row.value) : defaults;
  }

  function published(id, delivery) {
    const widget = selectWidget.get(id);
    if (!widget || (delivery && widget.delivery !== delivery)) throw missing();
    return widget;
  }

  function configuration(id) {
    const widget = published(id);
    const shops = listShops.all(widget.partner_id).filter(({ id }) => !widget.shop_id || id === widget.shop_id);
    return {
      id: widget.id,
      name: widget.name,
      delivery: widget.delivery,
      branding: readBrand(widget.partner_id),
      shopId: shops.length === 1 ? shops[0].id : null,
      shops,
    };
  }

  return {
    branding(actor, input) {
      owner(actor);
      if (input === undefined) return readBrand(actor.partnerId);
      const value = brandingValues(input);
      saveBrand.run(actor.partnerId, JSON.stringify(value));
      return value;
    },
    list(actor) {
      owner(actor);
      return listWidgets.all(actor.partnerId);
    },
    create(actor, { name, delivery, shopId = null }) {
      owner(actor);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || !modes.has(delivery)) {
        throw new OperationError(400, 'Podaj nazwę i sposób udostępnienia widżetu.');
      }
      if (shopId !== null && !listShops.all(actor.partnerId).some(({ id }) => id === shopId)) throw missing();
      const widget = { id: randomUUID(), name: name.trim(), delivery, shopId };
      insertWidget.run(widget.id, actor.partnerId, widget.name, delivery, shopId);
      return widget;
    },
    configuration,
    published,
    selectedShop(id, shopId) {
      const config = configuration(id);
      const selected = shopId ?? config.shopId;
      if (!selected) throw new OperationError(400, 'Wybierz punkt.');
      if (!config.shops.some(({ id }) => id === selected)) throw missing();
      return selected;
    },
  };
}
