# Pilotaż rezerwacji rowerów

Pilotaż obsługuje wielu Partnerów i wiele punktów. Klient wybiera kategorie rowerów, akcesoria oraz terminy odbioru i zwrotu w odstępach 30 minut, w godzinach otwarcia punktu i w polskim czasie lokalnym. Widżet i link płatniczy od obsługi korzystają z tego samego cennika i zapasu punktu. Dodatni zapas początkowy ma punkt pokazowy. W nowym punkcie właściciel lub przypisany pracownik ustawia ilości przed przyjęciem rezerwacji.

Lokalny symulator obsługuje przedpłaty i zwroty. Aplikacja zapisuje treść i adresatów wiadomości, a wysyłka e-mail wymaga podłączenia dostawcy. Obsługa może zatwierdzić zmianę terminu lub składu przy tej samej cenie oraz rozliczyć kwalifikujące się opłaty za sprzęt zdjęty przy odbiorze. Zmiana ceny przy modyfikacji opłaconej rezerwacji wymaga uzgodnienia sposobu rozliczenia.

## Uruchomienie

Wymagany jest Node.js 24. Po uruchomieniu aplikacja podaje adres widżetu, adres panelu obsługi oraz losowe hasło pokazowego właściciela `obsluga`. Możesz ustawić własne hasło pokazowe przez `DEMO_STAFF_PASSWORD`. Aplikacja nasłuchuje na adresie `127.0.0.1` i domyślnie zapisuje dane w `booking.sqlite`.

```sh
npm ci
npm start
```

W panelu właściciel może dodawać punkty, ustawiać kalendarz i limity, tworzyć loginy pracowników oraz przypisywać ich do punktów z uprawnieniem do zatwierdzania zwrotów. Pracownik loguje się tym samym adresem panelu. Widżet bez parametru otwiera początkowy punkt, a `/?shopId=<id-punktu>` pokazuje ofertę wskazanego punktu. Horyzont dotyczy terminu odbioru, a długość najmu liczy się w czasie rzeczywistym.

W sekcji **Widżety rezerwacji** właściciel ustawia adres HTTPS logo i kolory Partnera, wybiera punkt lub listę punktów i kopiuje adres hostowany albo kod osadzenia. Kod inline wklej w miejscu na formularz, a kod popup w miejscu na przycisk. Aby udostępnić je na publicznej stronie Partnera, otwórz panel pod publicznym adresem HTTPS aplikacji. Widżety pobierają aktualną ofertę punktu przy otwarciu formularza oraz zmianie punktu lub terminu.

## Testy

Testy uruchamiają lokalną aplikację z odrębną bazą w pamięci, danymi syntetycznymi i symulatorem. Instalacja Chromium wymaga dostępu do serwera pobierania Playwright, jeśli przeglądarki nie ma jeszcze w pamięci podręcznej.

```sh
npm test
npx playwright install chromium
npm run test:browser
```

Próby operatora uruchamia się osobno po uzyskaniu testowego konta Marketplace Model 2. [Instrukcja sandboxu Przelewy24](docs/p24-marketplace-sandbox.md)
