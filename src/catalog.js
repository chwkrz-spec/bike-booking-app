const hour = 60 * 60 * 1000;
const localHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw',
  hour: '2-digit',
  hourCycle: 'h23',
});

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

export function rentalSlots(now) {
  const start = Math.ceil((now + hour / 2) / hour) * hour;
  const slots = [];
  for (let pickup = start; pickup < start + 48 * hour; pickup += hour) {
    const hourInPoland = Number(localHour.format(pickup));
    if (hourInPoland < 10 || hourInPoland >= 18) continue;
    slots.push({
      id: new Date(pickup).toISOString(),
      pickupAt: pickup,
      returnAt: pickup + hour,
      total: category.hourlyRate,
    });
  }
  return slots;
}
