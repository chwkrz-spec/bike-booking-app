# Pilotaż rezerwacji rowerów

Wersja pokazowa udostępnia widżet dla syntetycznych punktów, jedną kategorię roweru oraz odbiór i zwrot co pół godziny w polskim czasie lokalnym. Przedpłatę i potwierdzenie e-mail obsługuje lokalny symulator. Po zweryfikowaniu przedpłaty widżet pokazuje numer rezerwacji i adres odbiorcy zapisanej wiadomości.

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
