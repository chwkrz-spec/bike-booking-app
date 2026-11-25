import { OperationError } from './operation-error.js';

export function shopLanguages(shop) {
  return shop.termsEn ? ['pl', 'en'] : ['pl'];
}

export function validateLanguage(shop, language) {
  if (!shopLanguages(shop).includes(language)) {
    throw new OperationError(400, 'Ten język nie jest dostępny dla tego punktu.');
  }
}

export function renterShop({ id, name, seller, description, nameEn, descriptionEn }, language) {
  return {
    id, name: language === 'en' ? nameEn || name : name, seller,
    description: language === 'en' ? descriptionEn : description,
  };
}

const defaultItemNames = new Map([
  ['Rower turystyczny', 'Touring bike'],
  ['Rower dziecięcy', 'Children’s bike'],
  ['Kask', 'Helmet'],
  ['Zapięcie', 'Bike lock'],
]);

export function renterItem(item, language) {
  return language === 'en' ? { ...item, name: defaultItemNames.get(item.name) ?? item.name } : item;
}
