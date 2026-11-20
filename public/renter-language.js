let language = 'pl';
const polishText = new WeakMap();

export function t(polish, english) {
  return language === 'en' ? english : polish;
}

export function setRenterLanguage(value) {
  language = value === 'en' ? 'en' : 'pl';
  document.documentElement.lang = language;
  for (const element of document.querySelectorAll('[data-en]')) {
    if (!polishText.has(element)) polishText.set(element, element.textContent);
    element.textContent = t(polishText.get(element), element.dataset.en);
  }
  const logo = document.getElementById('widget-logo');
  if (logo) logo.alt = t('Logo Partnera', 'Rental business logo');
}

const messages = new Map([
  ['Nie znaleziono punktu lub pracownika.', 'This shop could not be found.'],
  ['Brak dostępnych punktów.', 'No shops are available.'],
  ['Ten język nie jest dostępny dla tego punktu.', 'This shop does not currently offer checkout in this language.'],
  ['Nie znaleziono blokady.', 'This checkout hold could not be found.'],
  ['Wybierz termin z aktualnej oferty.', 'Choose a time from the current offer.'],
  ['Ta próba dotyczy innego wyboru.', 'This attempt belongs to a different selection.'],
  ['Ta próba dotyczy innego języka.', 'This attempt was started in a different language.'],
  ['Wybrany sprzęt jest już zajęty w tym terminie.', 'The selected equipment is already booked for this time.'],
  ['Wybierz prawidłowe ilości sprzętu i co najmniej jeden rower.', 'Enter valid quantities and select at least one bike.'],
  ['Podaj prawidłowy adres e-mail.', 'Enter a valid email address.'],
  ['Podaj prawidłowy numer telefonu.', 'Enter a valid phone number.'],
  ['Podaj jeden wzrost w centymetrach dla każdego roweru (50–250).', 'Enter one rider height per bike in centimetres (50–250).'],
  ['Zaakceptuj warunki najmu.', 'Accept the rental terms.'],
  ['Warunki najmu się zmieniły. Zapoznaj się z nimi ponownie.', 'The rental terms have changed. Review them before continuing.'],
  ['Blokada wygasła. Wybierz termin ponownie.', 'Your checkout hold has expired. Choose a time again.'],
  ['Link można wysłać w trakcie wypełniania formularza.', 'Send the link while your checkout hold is active.'],
  ['Link do dokończenia rezerwacji wygasł.', 'Your link to finish booking has expired.'],
  ['Dostępność lub cena uległa zmianie. Sprawdź aktualną ofertę.', 'Availability or pricing has changed. Review the current offer.'],
  ['Nie można anulować tej rezerwacji.', 'This booking cannot be cancelled.'],
  ['Kwota zwrotu się zmieniła. Sprawdź aktualną kwotę przed anulowaniem.', 'The refund amount has changed. Check the new amount before cancelling.'],
  ['Nie znaleziono rezerwacji.', 'This booking could not be found.'],
  ['Okno płatności wygasło.', 'The payment window has expired.'],
  ['Wystąpił błąd. Spróbuj ponownie.', 'Something went wrong. Try again.'],
]);

export function showRenterError(error) {
  if (error.language) setRenterLanguage(error.language);
  const element = document.getElementById('error');
  element.textContent = t(error.message, messages.get(error.message) ?? error.message);
  element.hidden = false;
}
