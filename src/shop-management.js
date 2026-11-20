import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { equipment, shop } from './catalog.js';
import { OperationError } from './operation-error.js';

const demoPartnerId = 'demo';
const identifier = /^[a-z0-9-]{3,50}$/;
const openingDay = [['10:00', '18:00']];
const defaultSettings = {
  weeklyHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, openingDay])),
  holidayHours: {},
  minimumNoticeMinutes: 30,
  bookingHorizonMinutes: 2880,
  maxRentalMinutes: 2880,
  turnaroundBufferMinutes: 0,
};

const keys = Object.keys(defaultSettings);
const badSettings = () => new OperationError(400, 'Nieprawidłowe ustawienia punktu.');
const forbidden = () => new OperationError(403, 'Ta operacja wymaga uprawnień właściciela.');
const missing = () => new OperationError(404, 'Nie znaleziono punktu lub pracownika.');

function textField(value, length) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > length) throw badSettings();
  return value.trim();
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hours(value) {
  const halfHour = /^(?:(?:[01]\d|2[0-3]):(?:00|30)|24:00)$/;
  let previousEnd = '';
  if (!Array.isArray(value)) throw badSettings();
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2) throw badSettings();
    const [start, end] = range;
    if (![start, end].every((time) => typeof time === 'string' && halfHour.test(time)) ||
        start >= end || start < previousEnd) throw badSettings();
    previousEnd = end;
  }
  return value;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function settingsUpdate(input, current, isOwner) {
  const fields = Object.keys(input);
  if (!isOwner && fields.some((key) => key !== 'minimumNoticeMinutes')) throw forbidden();
  if (!fields.length || fields.some((key) => !keys.includes(key))) throw badSettings();
  const settings = { ...current, ...input };
  for (const field of ['minimumNoticeMinutes', 'bookingHorizonMinutes', 'maxRentalMinutes', 'turnaroundBufferMinutes']) {
    const value = settings[field];
    const minimum = ['minimumNoticeMinutes', 'turnaroundBufferMinutes'].includes(field) ? 0 : 30;
    if (!Number.isInteger(value) || value < minimum || value > 366 * 1440) throw badSettings();
  }
  const { weeklyHours, holidayHours } = settings;
  const days = Object.keys(defaultSettings.weeklyHours);
  if (!object(weeklyHours) || Object.keys(weeklyHours).length !== days.length) throw badSettings();
  for (const day of days) hours(weeklyHours[day]);
  if (!object(holidayHours)) throw badSettings();
  for (const [date, value] of Object.entries(holidayHours)) {
    if (!isValidDate(date)) throw badSettings();
    hours(value);
  }
  return settings;
}

function equipmentItem({ name, kind, hourlyRate, dayRate = null, fullDayRate = null, bookingRate }, id) {
  const validRate = (value, minimum = 1) => Number.isInteger(value) && value >= minimum && value <= 1_000_000;
  const invalid = () => new OperationError(400, 'Podaj prawidłowe stawki sprzętu w groszach.');
  const item = { id, name: textField(name, 120), kind };
  if (kind === 'accessory') {
    if (!validRate(bookingRate, 0)) throw invalid();
    return { ...item, bookingRate };
  }
  if (kind !== 'bike' || !validRate(hourlyRate) || (dayRate !== null && !validRate(dayRate)) ||
      (fullDayRate !== null && !validRate(fullDayRate))) throw invalid();
  return { ...item, hourlyRate, dayRate, fullDayRate };
}

function requireOwner(actor) {
  if (actor.role !== 'owner') throw forbidden();
}

export function openShopManagement(db, { staffPassword, demoOwners = [] }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partners (
      id TEXT PRIMARY KEY,
      seller TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL REFERENCES partners(id),
      name TEXT NOT NULL,
      terms TEXT NOT NULL,
      settings TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shop_catalog (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      item_id TEXT NOT NULL,
      item TEXT NOT NULL,
      PRIMARY KEY (shop_id, item_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shop_stock (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      PRIMARY KEY (shop_id, item_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS staff_members (
      username TEXT PRIMARY KEY,
      partner_id TEXT NOT NULL REFERENCES partners(id),
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS shop_assignments (
      username TEXT NOT NULL REFERENCES staff_members(username),
      shop_id TEXT NOT NULL REFERENCES shops(id),
      can_refund INTEGER NOT NULL,
      PRIMARY KEY (username, shop_id)
    ) STRICT;
  `);
  const seedPartner = db.prepare('INSERT OR IGNORE INTO partners VALUES (?, ?)');
  const seedShop = db.prepare('INSERT OR IGNORE INTO shops VALUES (?, ?, ?, ?, ?)');
  const owners = new Map();
  seedPartner.run(demoPartnerId, JSON.stringify(shop.seller));
  seedShop.run(shop.id, demoPartnerId, shop.name, shop.terms, JSON.stringify(defaultSettings));
  for (const { username, password, partnerId } of [
    ...demoOwners,
    ...(staffPassword ? [{ username: 'obsluga', password: staffPassword, partnerId: demoPartnerId }] : []),
  ]) {
    seedPartner.run(partnerId, JSON.stringify(shop.seller));
    owners.set(username, { passwordHash: createHash('sha256').update(password).digest(), partnerId });
  }

  const selectShop = db.prepare(`
    SELECT s.*, p.seller FROM shops s JOIN partners p ON p.id = s.partner_id WHERE s.id = ?
  `);
  const selectAssignment = db.prepare('SELECT * FROM shop_assignments WHERE username = ? AND shop_id = ?');
  const selectShopIds = db.prepare('SELECT id FROM shops WHERE partner_id = ? ORDER BY name, id');
  const selectStaffShopIds = db.prepare(`
    SELECT s.id FROM shops s JOIN shop_assignments a ON a.shop_id = s.id
    WHERE s.partner_id = ? AND a.username = ? ORDER BY s.name, s.id
  `);
  const selectMember = db.prepare('SELECT * FROM staff_members WHERE username = ?');
  const selectMembers = db.prepare('SELECT username FROM staff_members WHERE partner_id = ? ORDER BY username');
  const selectMemberAssignments = db.prepare('SELECT shop_id AS shopId, can_refund AS canRefund FROM shop_assignments WHERE username = ?');
  const insertMember = db.prepare('INSERT OR IGNORE INTO staff_members VALUES (?, ?, ?, ?)');
  const upsertAssignment = db.prepare(`
    INSERT INTO shop_assignments VALUES (?, ?, ?)
    ON CONFLICT (username, shop_id) DO UPDATE SET can_refund = excluded.can_refund
  `);
  const deleteAssignment = db.prepare('DELETE FROM shop_assignments WHERE username = ? AND shop_id = ?');
  const selectPartner = db.prepare('SELECT seller FROM partners WHERE id = ?');
  const updatePartner = db.prepare('UPDATE partners SET seller = ? WHERE id = ?');
  const updateSettings = db.prepare('UPDATE shops SET settings = ? WHERE id = ?');
  const selectCatalog = db.prepare('SELECT item_id, item FROM shop_catalog WHERE shop_id = ? ORDER BY rowid');
  const upsertEquipment = db.prepare(`
    INSERT INTO shop_catalog VALUES (?, ?, ?)
    ON CONFLICT (shop_id, item_id) DO UPDATE SET item = excluded.item
  `);
  const selectQuantities = db.prepare('SELECT item_id, quantity FROM shop_stock WHERE shop_id = ?');
  const updateQuantity = db.prepare(`
    INSERT INTO shop_stock VALUES (?, ?, ?)
    ON CONFLICT (shop_id, item_id) DO UPDATE SET quantity = excluded.quantity
  `);

  function inventory(shopId) {
    const quantities = new Map(selectQuantities.all(shopId).map(({ item_id, quantity }) => [item_id, quantity]));
    const catalog = new Map(equipment.map((item) => [item.id, item]));
    for (const { item_id, item } of selectCatalog.all(shopId)) {
      catalog.set(item_id, { stock: catalog.get(item_id)?.stock ?? 0, ...JSON.parse(item) });
    }
    return [...catalog.values()].map(({ stock, ...item }) => ({ ...item, quantity: quantities.get(item.id) ?? stock }));
  }

  function accessible(actor, shopId) {
    const row = selectShop.get(shopId);
    if (!row || row.partner_id !== actor.partnerId) throw missing();
    if (actor.role === 'owner') return { row, canRefund: true };
    const assignment = selectAssignment.get(actor.username, shopId);
    if (!assignment) throw missing();
    return { row, canRefund: Boolean(assignment.can_refund) };
  }

  function settings(actor, shopId, input) {
    const { row } = accessible(actor, shopId);
    const current = { ...defaultSettings, ...JSON.parse(row.settings) };
    if (input === undefined) return current;
    const next = settingsUpdate(input, current, actor.role === 'owner');
    updateSettings.run(JSON.stringify(next), shopId);
    return next;
  }

  function shops(actor) {
    const ids = actor.role === 'owner' ? selectShopIds.all(actor.partnerId)
      : selectStaffShopIds.all(actor.partnerId, actor.username);
    return ids.map(({ id }) => {
      const { row, canRefund } = accessible(actor, id);
      return { id, name: row.name, canRefund };
    });
  }

  return {
    authenticate(header) {
      const match = header?.match(/^Basic ([\w+/=]+)$/i);
      if (!match) return null;
      const credentials = Buffer.from(match[1], 'base64').toString();
      const separator = credentials.indexOf(':');
      if (separator < 0) return null;
      const username = credentials.slice(0, separator);
      const password = credentials.slice(separator + 1);
      const owner = owners.get(username);
      if (owner && timingSafeEqual(owner.passwordHash, createHash('sha256').update(password).digest())) {
        return { username, partnerId: owner.partnerId, role: 'owner' };
      }
      const member = selectMember.get(username);
      if (member && timingSafeEqual(Buffer.from(member.password_hash, 'hex'), scryptSync(password, member.salt, 32))) {
        return { username, partnerId: member.partner_id, role: 'staff' };
      }
      return null;
    },
    publicShop(id = shop.id) {
      const row = selectShop.get(id);
      if (!row) throw missing();
      return {
        shop: { id: row.id, name: row.name, seller: JSON.parse(row.seller), terms: row.terms },
        settings: { ...defaultSettings, ...JSON.parse(row.settings) },
        partnerId: row.partner_id,
      };
    },
    accessible,
    settings,
    shops,
    createShop(actor, input) {
      requireOwner(actor);
      const name = textField(input.name, 120);
      const id = randomUUID();
      seedShop.run(id, actor.partnerId, name, shop.terms, JSON.stringify(defaultSettings));
      return { id, name, canRefund: true };
    },
    inventory,
    catalog(actor, shopId, input) {
      requireOwner(actor);
      accessible(actor, shopId);
      const items = inventory(shopId);
      if (input === undefined) return items;
      if (input.id !== undefined) {
        const current = items.find(({ id }) => id === input.id);
        if (!current) throw missing();
        if (current.kind !== input.kind) throw new OperationError(400, 'Nie można zmienić rodzaju zapisanego sprzętu.');
      }
      const item = equipmentItem(input, input.id ?? randomUUID());
      upsertEquipment.run(shopId, item.id, JSON.stringify(item));
      return item;
    },
    stock(actor, shopId, input) {
      accessible(actor, shopId);
      if (input !== undefined) {
        const { itemId, quantity } = input;
        if (!inventory(shopId).some(({ id }) => id === itemId) || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000) {
          throw new OperationError(400, 'Podaj prawidłową ilość sprzętu od 0 do 1000.');
        }
        updateQuantity.run(shopId, itemId, quantity);
      }
      return inventory(shopId).map(({ id, name, kind, quantity }) => ({ id, name, kind, quantity }));
    },
    partner(actor, input) {
      requireOwner(actor);
      const seller = JSON.parse(selectPartner.get(actor.partnerId).seller);
      if (input === undefined) return seller;
      const fields = Object.keys(input);
      if (!fields.length || fields.some((field) => !Object.hasOwn(seller, field))) throw badSettings();
      for (const field of fields) seller[field] = textField(input[field], 180);
      if (!/^\d{10}$/.test(seller.nip)) throw badSettings();
      updatePartner.run(JSON.stringify(seller), actor.partnerId);
      return seller;
    },
    members(actor) {
      requireOwner(actor);
      return selectMembers.all(actor.partnerId).map(({ username }) => ({
        username,
        assignments: selectMemberAssignments.all(username).map(({ shopId, canRefund }) => ({
          shopId, canRefund: Boolean(canRefund),
        })),
      }));
    },
    createMember(actor, { username, password }) {
      requireOwner(actor);
      if (typeof username !== 'string' || !identifier.test(username) ||
          typeof password !== 'string' || password.length < 12 || password.length > 128) {
        throw new OperationError(400, 'Podaj login (3–50 małych liter, cyfr lub myślników) i hasło (12–128 znaków).');
      }
      if (owners.has(username)) throw new OperationError(409, 'Ten login jest zajęty.');
      const salt = randomBytes(16).toString('hex');
      const passwordHash = scryptSync(password, salt, 32).toString('hex');
      if (insertMember.run(username, actor.partnerId, salt, passwordHash).changes === 0) {
        throw new OperationError(409, 'Ten login jest zajęty.');
      }
      return { username, assignments: [] };
    },
    assignment(actor, username, { shopId, canRefund, assigned = true }) {
      requireOwner(actor);
      const member = selectMember.get(username);
      if (!member || member.partner_id !== actor.partnerId || typeof shopId !== 'string') throw missing();
      accessible(actor, shopId);
      if (typeof canRefund !== 'boolean' || typeof assigned !== 'boolean') throw badSettings();
      if (assigned) upsertAssignment.run(username, shopId, Number(canRefund));
      else deleteAssignment.run(username, shopId);
      return { shopId, canRefund: assigned && canRefund, assigned };
    },
  };
}
