import { get, request } from './common.js';

const widgetForm = get('create-widget');
const brandingForm = get('widget-branding');
const list = get('widget-list');

export function showWidgetShops(shops) {
  const select = widgetForm.elements.shopId;
  const selected = select.value;
  select.replaceChildren(new Option('Klient wybiera punkt', ''),
    ...shops.map(({ id, name }) => new Option(name, id)));
  if (shops.some(({ id }) => id === selected)) select.value = selected;
  widgetForm.querySelector('button').disabled = shops.length === 0;
}

function snippet({ id, delivery }) {
  const origin = window.location.origin;
  const url = origin + '/widgets/' + id;
  if (delivery === 'inline') {
    return '<iframe src="' + url + '/inline" width="100%" height="780" loading="lazy" title="Rezerwacja roweru"></iframe>';
  }
  if (delivery === 'popup') {
    return '<script src="' + origin + '/assets/widget-popup.js?widget=' + id + '" defer></script>';
  }
  return url;
}

function widgetCard(widget) {
  const group = document.createElement('fieldset');
  const title = document.createElement('legend');
  const value = document.createElement('textarea');
  const copy = document.createElement('button');
  const status = document.createElement('p');
  const type = widget.delivery === 'hosted' ? 'Adres strony hostowanej' :
    widget.delivery === 'inline' ? 'Kod formularza inline' : 'Kod przycisku popup';
  title.textContent = widget.name;
  value.setAttribute('aria-label', type);
  value.value = snippet(widget);
  value.rows = widget.delivery === 'hosted' ? 2 : 3;
  value.readOnly = true;
  copy.type = 'button';
  copy.className = 'secondary';
  copy.textContent = 'Kopiuj';
  status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value.value);
      status.textContent = 'Skopiowano.';
    } catch {
      value.focus();
      value.select();
      status.textContent = 'Zaznaczono tekst do skopiowania.';
    }
  });
  group.append(title, value, copy, status);
  return group;
}

export async function setupWidgets(saves) {
  const [branding, widgets] = await Promise.all([
    request('/api/staff/widget-branding'), request('/api/staff/widgets'),
  ]);
  for (const [field, value] of Object.entries(branding)) brandingForm.elements[field].value = value;
  list.replaceChildren(...widgets.map(widgetCard));

  saves(brandingForm, async () => {
    await request('/api/staff/widget-branding', Object.fromEntries(new FormData(brandingForm)));
    return 'Zapisano wygląd widżetów.';
  });
  saves(widgetForm, async () => {
    const form = Object.fromEntries(new FormData(widgetForm));
    const widget = await request('/api/staff/widgets', { ...form, shopId: form.shopId || null });
    list.prepend(widgetCard(widget));
    widgetForm.reset();
    return 'Utworzono widżet.';
  });
  get('widgets-admin').hidden = false;
}
