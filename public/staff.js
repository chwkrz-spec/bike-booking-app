import { formatAmount, formatSlot, get, request, showError } from './common.js';
import { amendmentControls } from './staff-amendments.js';
import { catalogForms, equipmentOperations, pickupControls, stockForms } from './staff-equipment.js';

import { setupAssistedBooking } from './staff-assisted.js';
import { setupWidgets, showWidgetShops } from './staff-widgets.js';

const dayNames = {
  mon: 'Poniedziałek', tue: 'Wtorek', wed: 'Środa', thu: 'Czwartek',
  fri: 'Piątek', sat: 'Sobota', sun: 'Niedziela',
};
const shopSelect = get('staff-shop');
const shopForm = get('shop-settings');
const renterCopyForm = get('shop-renter-copy');
const copyShopForm = get('copy-shop-configuration');
const partnerForm = get('partner-settings');
const policyForm = get('cancellation-policy');
const policyPath = '/api/staff/cancellation-policy';
const bookingStatus = { confirmed: 'Potwierdzona', cancelled: 'Anulowana', no_show: 'No-Show' };
const assignmentForm = get('assignment');
let owner;
let members = [];
let viewingShop = 0;

function cell(row, ...values) {
  const element = row.insertCell();
  for (const value of values) {
    const line = document.createElement('div');
    line.textContent = value;
    element.append(line);
  }
  return element;
}

function displayBookings(bookings, stock) {
  const list = get('reservations');
  list.replaceChildren();
  for (const booking of bookings) {
    const row = list.insertRow();
    cell(row, formatSlot(booking));
    cell(row, ...booking.allocatedItems.map(({ name, quantity }) => name + ' × ' + quantity));
    cell(row, booking.email, booking.phone);
    cell(row, ...booking.riderHeights.map((height) => height + ' cm'));
    cell(row, formatAmount(booking.total, booking.currency));
    const status = cell(row, bookingStatus[booking.status] ?? booking.status, booking.id);
    if (booking.cancellationRefund !== undefined) {
      status.append('Zwrot po anulowaniu: ' + formatAmount(booking.cancellationRefund, booking.currency));
    }
    if (booking.canCancel) {
      const form = document.createElement('form');
      const button = document.createElement('button');
      button.type = 'submit';
      button.className = 'secondary';
      button.textContent = 'Anuluj rezerwację';
      form.append(button);
      status.append(form);
      saves(form, async () => {
        const refund = formatAmount(booking.partnerCancellationRefund, booking.currency);
        if (!window.confirm('Anulować całą rezerwację i zwrócić ' + refund + '?')) return;
        await request('/api/staff/bookings/' + booking.id + '/cancel', {});
        await refreshShop();
        return 'Anulowano rezerwację.';
      });
    }
    status.append(amendmentControls(booking, stock, saves, refreshShop));
    const pickup = pickupControls(booking, saves, refreshShop);
    if (pickup) status.append(pickup);
    status.append(equipmentOperations(booking, stock, saves, refreshShop));
  }
  get('list').hidden = bookings.length === 0;
  get('empty').hidden = bookings.length !== 0;
}

function showSuccess(message) {
  get('saved').textContent = message;
  get('saved').hidden = false;
}

function formValues(form) {
  return Object.fromEntries(new FormData(form));
}

function staffShopPath(resource) {
  return '/api/staff/shops/' + shopSelect.value + '/' + resource;
}

function holidayHours(value) {
  const overrides = Object.create(null);
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const [date] = line.trim().split(/\s+/, 1);
    if (Object.hasOwn(overrides, date)) throw new Error('Data wyjątku pojawia się więcej niż raz.');
    overrides[date] = parseHours(line.trim().slice(date.length));
  }
  return overrides;
}

function parseHours(value) {
  return value.trim() ? value.split(',').map((range) => range.trim().split(/\s*[-–]\s*/)) : [];
}

function showHours(ranges) {
  return ranges.map((range) => range.join('–')).join(', ');
}

function displaySettings(settings) {
  shopForm.elements.minimumNoticeMinutes.value = settings.minimumNoticeMinutes;
  if (!owner) return;
  shopForm.elements.bookingHorizonMinutes.value = settings.bookingHorizonMinutes;
  shopForm.elements.maxRentalMinutes.value = settings.maxRentalMinutes;
  shopForm.elements.turnaroundBufferMinutes.value = settings.turnaroundBufferMinutes;
  const inputs = get('opening-hours');
  inputs.replaceChildren();
  for (const [day, name] of Object.entries(dayNames)) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.textContent = name;
    label.htmlFor = 'hours-' + day;
    input.id = label.htmlFor;
    input.value = showHours(settings.weeklyHours[day]);
    inputs.append(label, input);
  }
  get('holiday-hours').value = Object.entries(settings.holidayHours)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, ranges]) => (date + ' ' + showHours(ranges)).trim())
    .join('\n');
}

async function refreshShop() {
  const selected = ++viewingShop;
  const loadAssisted = refreshAssistedBooking(shopSelect.value);
  get('shop-admin').hidden = true;
  get('list').hidden = true;
  get('empty').hidden = true;
  if (!shopSelect.value) return;
  try {
    const catalogPath = staffShopPath('catalog');
    const [bookings, stock, settings, catalog, renterCopy] = await Promise.all([
      request(staffShopPath('bookings')), request(staffShopPath('stock')), request(staffShopPath('settings')),
      owner ? request(catalogPath) : [], owner ? request(staffShopPath('renter-copy')) : null, loadAssisted,
    ]);
    if (selected !== viewingShop) return;
    displayBookings(bookings, stock);
    get('staff-stock').replaceChildren(...stockForms(stock, staffShopPath('stock'), saves, refreshShop));
    get('staff-catalog').replaceChildren(...catalogForms(catalog, catalogPath, saves, refreshShop));
    displaySettings(settings);
    if (owner) {
      for (const [field, value] of Object.entries(renterCopy)) renterCopyForm.elements[field].value = value;
      renterCopyForm.hidden = false;
      const sources = Array.from(shopSelect.options).filter(({ value }) => value !== shopSelect.value);
      copyShopForm.elements.sourceShopId.replaceChildren(new Option('Wybierz punkt', ''),
        ...sources.map(({ text, value }) => new Option(text, value)));
      copyShopForm.hidden = sources.length === 0;
    }
    get('shop-admin').hidden = false;
  } catch (error) {
    if (selected === viewingShop) showError(error);
  }
}

function assignmentState() {
  const { username, shopId, assigned, canRefund } = assignmentForm.elements;
  const member = members.find((entry) => entry.username === username.value);
  const assignment = member?.assignments.find((entry) => entry.shopId === shopId.value);
  assigned.checked = Boolean(assignment);
  canRefund.checked = assignment?.canRefund ?? false;
  canRefund.disabled = !assigned.checked;
}

async function refreshMembers(selected) {
  members = await request('/api/staff/members');
  const memberSelect = get('assignment-member');
  memberSelect.replaceChildren(...members.map(({ username }) => new Option(username, username)));
  if (selected) memberSelect.value = selected;
  assignmentForm.hidden = members.length === 0 || shopSelect.options.length === 0;
  assignmentState();
}

async function refreshShops(selected = shopSelect.value) {
  const shops = await request('/api/staff/shops');
  for (const select of [shopSelect, get('assignment-shop')]) {
    select.replaceChildren(...shops.map(({ id, name }) => new Option(name, id)));
    if (shops.some(({ id }) => id === selected)) select.value = selected;
  }
  shopSelect.hidden = get('staff-shop-label').hidden = shops.length === 0;
  get('refresh-bookings').hidden = shops.length === 0;
  get('no-shops').hidden = shops.length > 0;
  if (owner) {
    showWidgetShops(shops);
    assignmentForm.hidden = members.length === 0 || shops.length === 0;
    assignmentState();
  }
  await refreshShop();
}

function saves(form, callback) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    get('error').hidden = true;
    get('saved').hidden = true;
    try {
      const message = await callback();
      if (message) showSuccess(message);
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  });
}

saves(renterCopyForm, async () => {
  const shopId = shopSelect.value;
  await request(staffShopPath('renter-copy'), formValues(renterCopyForm));
  if (shopSelect.value === shopId) await refreshAssistedBooking(shopId);
  return 'Zapisano treści dla klientów.';
});
saves(copyShopForm, async () => {
  await request(staffShopPath('copy-configuration'), formValues(copyShopForm));
  await refreshShop();
  return 'Skopiowano konfigurację punktu.';
});
saves(shopForm, async () => {
  const { minimumNoticeMinutes, bookingHorizonMinutes, maxRentalMinutes, turnaroundBufferMinutes } = formValues(shopForm);
  const settings = { minimumNoticeMinutes: Number(minimumNoticeMinutes) };
  if (owner) {
    settings.bookingHorizonMinutes = Number(bookingHorizonMinutes);
    settings.maxRentalMinutes = Number(maxRentalMinutes);
    settings.turnaroundBufferMinutes = Number(turnaroundBufferMinutes);
    settings.weeklyHours = Object.fromEntries(Object.keys(dayNames).map((day) => [day, parseHours(get('hours-' + day).value)]));
    settings.holidayHours = holidayHours(get('holiday-hours').value);
  }
  await request(staffShopPath('settings'), settings);
  return 'Zapisano ustawienia punktu.';
});
saves(partnerForm, async () => {
  await request('/api/staff/partner', formValues(partnerForm));
  return 'Zapisano dane sprzedawcy.';
});
saves(policyForm, async () => {
  const policy = Object.fromEntries(Object.entries(formValues(policyForm)).map(([name, value]) => [name, Number(value)]));
  await request(policyPath, policy);
  return 'Zapisano politykę anulowania.';
});
saves(get('create-shop'), async () => {
  const form = get('create-shop');
  const { id } = await request('/api/staff/shops', formValues(form));
  form.reset();
  await refreshShops(id);
  return 'Dodano punkt.';
});
saves(get('create-member'), async () => {
  const form = get('create-member');
  const { username } = await request('/api/staff/members', formValues(form));
  form.reset();
  await refreshMembers(username);
  return 'Dodano pracownika.';
});
saves(assignmentForm, async () => {
  const { username, shopId, assigned, canRefund } = assignmentForm.elements;
  await request('/api/staff/members/' + username.value + '/assignments', {
    shopId: shopId.value, assigned: assigned.checked, canRefund: canRefund.checked,
  });
  await refreshMembers(username.value);
  return 'Zapisano uprawnienia.';
});
const refreshAssistedBooking = setupAssistedBooking(saves);
shopSelect.addEventListener('change', refreshShop);
get('assignment-member').addEventListener('change', assignmentState);
get('assignment-shop').addEventListener('change', assignmentState);
assignmentForm.elements.assigned.addEventListener('change', () => {
  assignmentForm.elements.canRefund.disabled = !assignmentForm.elements.assigned.checked;
});

try {
  const session = await request('/api/staff/session');
  owner = session.role === 'owner';
  for (const id of ['owner-schedule', 'owner-catalog', 'partner-admin', 'policy-admin', 'member-admin']) get(id).hidden = !owner;
  await refreshShops();
  if (owner) {
    const [partner, policy] = await Promise.all([
      request('/api/staff/partner'), request(policyPath), refreshMembers(), setupWidgets(saves),
    ]);
    for (const [field, value] of Object.entries(policy)) policyForm.elements[field].value = value;
    for (const [field, value] of Object.entries(partner)) partnerForm.elements[field].value = value;
  }
} catch (error) {
  showError(error);
}

get('refresh-bookings').addEventListener('click', refreshShop);
