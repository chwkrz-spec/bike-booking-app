# Pilotaż rezerwacji rowerów

Wersja pokazowa udostępnia widżet dla jednego syntetycznego punktu, jedną kategorię roweru i godzinne terminy w polskim czasie lokalnym. Przedpłatę i potwierdzenie e-mail obsługuje lokalny symulator. Po zweryfikowaniu przedpłaty widżet pokazuje numer rezerwacji i adres odbiorcy zapisanej wiadomości.

## Uruchomienie

Wymagany jest Node.js 24. Po uruchomieniu aplikacja podaje adres widżetu, adres panelu obsługi oraz losowe hasło użytkownika `obsluga`. Możesz ustawić własne hasło pokazowe przez `DEMO_STAFF_PASSWORD`. Aplikacja nasłuchuje na adresie `127.0.0.1` i domyślnie zapisuje dane w `booking.sqlite`.

```sh
npm ci
npm start
```

## Testy

Testy uruchamiają lokalną aplikację z odrębną bazą w pamięci, danymi syntetycznymi i symulatorem. Instalacja Chromium wymaga dostępu do serwera pobierania Playwright, jeśli przeglądarki nie ma jeszcze w pamięci podręcznej.

```sh
npm test
npx playwright install chromium
npm run test:browser
```
