import { get, request } from './common.js';

function availableStorage() {
  try {
    return window.sessionStorage;
  } catch {
    const temporary = new Map();
    return {
      getItem: (key) => temporary.get(key) ?? null,
      setItem: (key, value) => temporary.set(key, value),
      removeItem: (key) => temporary.delete(key),
    };
  }
}

function applyBranding({ logoUrl, accentColor, backgroundColor }) {
  if (logoUrl) {
    const logo = get('widget-logo');
    logo.src = logoUrl;
    logo.hidden = false;
  }
  const root = document.documentElement;
  root.classList.add('branded-widget');
  root.style.setProperty('--widget-background', backgroundColor);
  root.style.setProperty('--widget-accent', accentColor);

  const channels = accentColor.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  root.style.setProperty('--widget-button-text', luminance > 0.179 ? '#000' : '#fff');
}

export function openWidgetContext() {
  const id = window.location.pathname.match(/^\/widgets\/([\w-]+)/)?.[1];
  let shopId = new URLSearchParams(window.location.search).get('shopId');
  const scope = id ? ':widget:' + id : shopId ? ':' + shopId : '';
  const storage = availableStorage();
  const shopKey = 'bike-widget-shop' + scope;
  const apiPrefix = id ? '/api/widgets/' + id : '/api';
  let canChooseShop = false;

  return {
    scope,
    storage,
    apiPrefix,
    get shopId() { return shopId; },
    async load() {
      if (!id) return;
      const config = await request(apiPrefix);
      applyBranding(config.branding);
      if (config.shops.length === 0) throw new Error('Brak dostępnych punktów.');
      canChooseShop = !config.shopId;
      const saved = storage.getItem(shopKey);
      shopId = config.shopId || (config.shops.some(({ id }) => id === saved) ? saved : config.shops[0].id);
      const picker = get('widget-shop');
      picker.replaceChildren(...config.shops.map(({ id, name }) => new Option(name, id)));
      picker.value = shopId;
    },
    selectShop(selected) {
      shopId = selected;
      storage.setItem(shopKey, selected);
    },
    showPicker(visible) {
      get('shop-picker').hidden = !visible || !canChooseShop;
    },
  };
}
