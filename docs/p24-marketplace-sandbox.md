# Sandbox Przelewy24 Marketplace Model 2

[#17](https://github.com/chwkrz-spec/bike-booking-app/issues/17) pozostaje otwarte. Zestaw kontraktowy i narzędzie do przygotowania prób są dostępne. Brakuje konta platformy w sandboxie z aktywnym Marketplace Model 2 oraz testowego subkonta Partnera. Wyniki prób operatora, zachowanie okna płatności i rozliczenie pozostają do potwierdzenia.

Kod aplikacji, `npm test` i `npm run test:browser` korzystają z danych syntetycznych. Osobne `npm run test:sandbox` wykonuje żądania do sandboxu P24 i weryfikuje zebrane płatności. Adres sandboxu jest stały. Narzędzie odrzuca przekierowania odpowiedzi API.

## Dostęp i dane

Właściciel uzyskuje od Przelewy24 dostęp do sandboxu Marketplace Model 2 i testowego subkonta Partnera. Z operatorem ustala dostępne testowe metody płatności, uprawnienia do dyspozycji i zwrotów, limity kwot oraz możliwość symulacji wypłaty. Do prób potrzebny jest oddzielny endpoint HTTPS pod kontrolą zespołu, który zapisuje treść powiadomienia i moment odbioru w UTC, oraz adres powrotu dla testowej płatności. Szczegóły API są w [specyfikacji REST](https://developers.przelewy24.pl/) i [specyfikacji Marketplace](https://developers.przelewy24.pl/marketplace/p24MarketplaceAPIDocumentation_1.0.1_en.yaml).

Ustaw w środowisku uruchomienia tylko poświadczenia sandboxu. Dane dostępowe, adresy sesji i surowe powiadomienia przechowuj poza repozytorium.

| Zmienna | Wartość |
| --- | --- |
| `P24_SANDBOX_MERCHANT_ID` | Testowy identyfikator konta platformy |
| `P24_SANDBOX_POS_ID` | Testowy POS do REST API |
| `P24_SANDBOX_API_KEY` | Klucz REST API przypisany do POS |
| `P24_SANDBOX_CRC` | Klucz CRC do podpisu REST API |
| `P24_SANDBOX_MARKETPLACE_API_KEY` | Klucz Marketplace przypisany do testowego konta platformy |
| `P24_SANDBOX_FIXTURE` | Ścieżka do pliku JSON z zapisanymi danymi prób |

## Przygotowanie i sprawdzenie prób

Uruchamiaj akcje poleceniem `npm run p24:sandbox -- <akcja> <plik.json>`. Identyfikatory zamówień P24 i kont są liczbami całkowitymi. Kwoty to całkowita liczba groszy. Przy przerwanym lub niejednoznacznym żądaniu zapisu sprawdź stan w P24 przed ponowieniem. Rejestracje, dyspozycje i zwroty używają własnych unikalnych identyfikatorów.

| Akcja | Pola pliku wejściowego |
| --- | --- |
| `register` | `sessionId`, `amount`, `timeLimit` w minutach, `urlReturn`, `urlStatus` |
| `verify` | `payment` z `sessionId` i `amount` zapisanymi przy rejestracji oraz oryginalne `notification` z callbacku |
| `transaction` | `sessionId` |
| `dispatch` | `batchId`, `orderId`, `sessionId`, `sellerId` testowego subkonta, `amount` dyspozycji |
| `dispatchInfo` | `orderId` |
| `refund` | `requestId`, `refundsUuid`, `orderId`, `sessionId`, `amount` zwrotu, `data` jako tablica wpisów `{spId, spAmount}` oraz opcjonalne `urlStatus` |
| `refunds` | `orderId` |
| `balance` | `merchantId` konta do odczytu salda |

Kwotę zapisaną przy rejestracji zachowaj oddzielnie od treści powiadomienia. Zwrócony adres otwórz w przeglądarce i opłać przy użyciu testowej metody P24. Do trzech prób weryfikacji pozostaw płatności bez wcześniejszego wywołania `verify`. Pozostałe trzy transakcje przygotuj wcześniej przez `verify` i odpowiednią akcję Marketplace. Plik dowodów wymaga sześciu osobnych sesji:

| Klucz w JSON | Dane i sposób uzyskania |
| --- | --- |
| `prepayment` | `sessionId`, pierwotna kwota `amount`, pierwsze oryginalne `notification`. Test weryfikuje podpis, kwotę i status płatności. |
| `repeatedNotification` | `sessionId`, `amount`, `first` i `retry`, każdy z `receivedAt` i `notification`. Odłóż weryfikację, żeby P24 dostarczył drugie powiadomienie. Zapisz obie dostawy i dopiero uruchom test. |
| `latePayment` | `sessionId`, `amount`, lokalny `checkoutExpiresAt`, `receivedAt` i `notification`. Przygotuj próbę, w której P24 przyjmie zapłatę lub dostarczy powiadomienie po upływie niezależnej lokalnej blokady. Odnotuj, które zdarzenie nastąpiło po terminie. |
| `replacedLinkRefund` | `sessionId`, `orderId`, `requestId`. Oznacz pierwszą sesję jako zastąpioną przed opłaceniem pierwszego linku. Po weryfikacji zapłaty 1000 PLN wykonaj jeden pełny zwrot według procedury uzgodnionej z P24. |
| `partialRefund` | `sessionId`, `orderId`, `requestId`. Po weryfikacji zapłaty 1000 PLN i dyspozycji dla konta Partnera zleć 500 PLN zwrotu. Uzgodnione z P24 obciążenia przekaż jawnie. Plan biznesowy zakłada 475 PLN po stronie Partnera i 25 PLN prowizji. |
| `settlement` | `sessionId`, `orderId`, `sellerId`. Po weryfikacji 1000 PLN zleć dyspozycję 950 PLN na testowe subkonto zgodnie z procedurą dostawcy. Test odczytuje kwotę dyspozycji i raportuje resztę zwróconą przez P24. |

Daty w pliku dowodów zapisuj w UTC z końcówką `Z`. Kod kontraktowy sprawdza efekt operacji obserwowalny w P24. Podmiana linku, jednokrotne potwierdzenie rezerwacji i decyzja o zwrocie pozostają sprawdzane w testach syntetycznych aplikacji. Odpowiedź na polecenie `refund` dotyczy przyjęcia żądania. Zestaw kontraktowy wymaga, żeby odpowiedź odczytu potwierdziła zakończenie zwrotu. Do ponownego pełnego przebiegu przygotuj świeże próby weryfikacji.

## Obserwacje do zapisania z P24

- **Okno czasu.** Zarejestruj transakcje z limitem 15 minut. Zapisz czasy rozpoczęcia i zakończenia rejestracji, pierwszego otwarcia i odświeżenia strony P24, ostatniej dopuszczonej próby oraz pierwszej odmowy. Porównaj natychmiastowe otwarcie i otwarcie po celowym opóźnieniu. Użyj osobnych sesji do prób przed granicą i po niej. Zapisz metodę testową, zachowanie przy opóźnionej autoryzacji i moment dostarczenia podpisanego powiadomienia. Zsynchronizowany termin można pokazać po uzyskaniu wyniku operatora.
- **Rozliczenie.** Zapisz identyfikatory sesji, dyspozycji i zwrotów oraz raport lub salda obu kont przed dyspozycją, po dyspozycji i po zwrocie. Zestaw planowane 950/50 PLN z ruchem środków, opłatą bramki i stanem wypłaty. Pole `amountLeft` opisuje resztę według API. Do przypisania przychodu i opłaty potrzebne jest uzgodnienie z raportem P24.
- **Zwrot po wypłacie.** Jeśli sandbox pozwala zakończyć testową wypłatę, przeprowadź odrębną próbę zwrotu po jej potwierdzeniu. Zapisz saldo, sposób zasilenia, oba obciążenia, status zwrotu i korektę prowizji. Gdy sandbox nie obsługuje danego zdarzenia, zapisz ograniczenie i poproś operatora o potwierdzenie procedury.
- **Wynik #17.** Zarejestruj datę, wynik każdego scenariusza, ograniczenia i pytania do Przelewy24 w zgłoszeniu. [#18](https://github.com/chwkrz-spec/bike-booking-app/issues/18) pozostaje etapem potwierdzenia warunków umowy, rozliczeń, gotowości subkont, przeglądu prawno-księgowego i odnotowania decyzji właściciela o prawdziwych płatnościach.
