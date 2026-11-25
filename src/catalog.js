export const shop = {
  id: 'warszawa-demo',
  name: 'Warszawa – punkt pokazowy',
  seller: {
    legalName: 'Rowerowy Punkt Testowy sp. z o.o.',
    address: 'ul. Przykładowa 1, 00-001 Warszawa',
    nip: '0000000000',
  },
  terms: 'Przedpłata obejmuje cały najem. Nieopłacony rower wraca do dostępnej puli po wygaśnięciu blokady lub okna płatności.',
};

export const category = {
  id: 'rower-turystyczny',
  name: 'Rower turystyczny',
  stock: 1,
  hourlyRate: 2000,
};

export const equipment = [
  { id: category.id, name: category.name, kind: 'bike', stock: category.stock, hourlyRate: category.hourlyRate },
  { id: 'rower-dzieciecy', name: 'Rower dziecięcy', kind: 'bike', stock: 2, hourlyRate: 1500 },
  { id: 'kask', name: 'Kask', kind: 'accessory', stock: 3, bookingRate: 500 },
  { id: 'zapiecie', name: 'Zapięcie', kind: 'accessory', stock: 2, bookingRate: 0 },
];
