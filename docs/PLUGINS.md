# Pluginy Hermitty

Plugin to folder z plikiem `plugin.json` i kodem w JavaScript, spakowany do `.zip`. Importujesz go w **Ustawienia → Pluginy → Importuj .zip**, przeglądasz wymagane uprawnienia i włączasz przełącznikiem. Włączony plugin uruchamia się od razu i przy każdym starcie aplikacji.

Typy całego API: [`plugins/sdk/hermitty-plugin.d.ts`](../plugins/sdk/hermitty-plugin.d.ts).
Przykłady: `plugins/notes`, `plugins/bcgrnd_process`, `plugins/sysmon`, `plugins/ports`, `plugins/pomodoro`.

## Struktura archiwum

```
moj-plugin.zip
├── plugin.json      wymagany, w katalogu głównym archiwum (albo w jedynym podfolderze)
├── main.js          moduł ES wskazany w "main"
├── icon.svg         opcjonalnie
└── ui/, assets/     dowolne dodatkowe pliki
```

Pakowanie: `powershell scripts/pack-plugins.ps1` tworzy `release/plugins/<id>-<wersja>.zip` dla każdego folderu w `plugins/`.

## plugin.json

| Pole | Wymagane | Opis |
|---|---|---|
| `id` | tak | Unikalny identyfikator w odwróconej domenie, np. `acme.hello`. Import pluginu o istniejącym `id` to aktualizacja. |
| `name` | tak | Nazwa widoczna w UI. |
| `version` | tak | Semver. |
| `apiVersion` | tak | Na razie `1`. |
| `main` | tak | Ścieżka do modułu ES z `activate(tx)`. |
| `permissions` | tak | Lista uprawnień (niżej). Pusta lista oznacza plugin bez dostępu do czegokolwiek poza własnym UI. |
| `contributes` | nie | Co plugin dodaje: `sidebar`, `statusBar`, `commands`, `tabTypes`, `tabMenu` (pozycje w menu PPM zakładki), `settingsCommand` (komenda otwierająca własne okno ustawień; w Ustawienia → Pluginy pojawia się przycisk „Ustawienia”). Element paska ma pole `place`: `bottom` (pasek statusu) albo `top` (górny pasek okna). |
| `config` | nie | Domyślna konfiguracja. Typy wartości (tekst, liczba, tak/nie) wyznaczają formularz w Ustawieniach. Użytkownik może ją zmienić i przywrócić domyślną. |
| `author`, `description`, `icon`, `homepage`, `minAppVersion` | nie | Metadane. |

## Uprawnienia

| Uprawnienie | Daje | Ryzyko |
|---|---|---|
| `storage` | Pliki we własnym katalogu danych pluginu | niskie |
| `ui:sidebar`, `ui:statusbar`, `ui:tab`, `ui:commands` | Sekcja w pasku bocznym, element paska statusu, własny typ zakładki, komendy w palecie | niskie |
| `notifications` | Powiadomienia | niskie |
| `ui:tabmenu` | Pozycje w menu kontekstowym zakładki | niskie |
| `system:info` | Odczyt CPU, RAM, dysku | niskie |
| `terminal:read` | Wyjście terminali (linie z monitami o hasło są wycinane przez host) | średnie |
| `tabs:manage` | Lista zakładek, parkowanie i przywracanie zakładek, zamykanie z cofnięciem, przyjmowanie zakładek upuszczonych na sekcję | średnie |
| `ai:invoke` | Zapytania do AI przez skonfigurowanych providerów | średnie |
| `ai:usage` | Zużycie tokenów per provider (dzień, miesiąc, łącznie), limity z nagłówków ostatniej odpowiedzi i saldo konta (OpenRouter, DeepSeek). Bez kluczy i treści rozmów | niskie |
| `net:localhost` | Sieć tylko do localhost | średnie |
| `terminal:write` | Wpisywanie do terminali | wysokie |
| `net:*` | Sieć do dowolnych adresów | wysokie |
| `fs:read`, `fs:write` | Pliki użytkownika poza katalogiem pluginu (wybrane przez użytkownika foldery) | wysokie |
| `shell:exec` | Uruchamianie procesów | wysokie |
| `ai:plans` | Zużycie planów subskrypcji (Claude, Codex, Gemini CLI, Cursor, z.ai, OpenCode Go, OpenRouter) z logowania danego narzędzia na tym komputerze. Token czyta tylko rdzeń, plugin dostaje procenty i czasy resetu. `tx.ai.accounts()` zwraca dodatkowe konta Claude Code i Codex (id, usługa, nazwa), a `tx.ai.plan(usługa, idKonta)` limity takiego konta. Tylko pluginy wbudowane; import .zip je odrzuca | wysokie |
| `vault:keys` | Sejf kluczy API (`tx.keys`): zapis klucza wpisanego w oknie hosta, wersje zamaskowane, kopiowanie do schowka przez host. Tylko pluginy wbudowane; import .zip je odrzuca | wysokie |

Uprawnienia wysokiego ryzyka są oznaczone przy imporcie i na liście pluginów.

### Czego plugin nie dostanie nigdy

Importer odrzuca archiwum, które prosi o dowolne z: `secrets`, `keychain`, `credentials`, `keystrokes`, `clipboard:read`, `providers:keys`, `vault:*`. Niezależnie od manifestu host:

- nie udostępnia magazynu poświadczeń, haseł z Vaulta ani kluczy API providerów (`tx.ai` wysyła zapytanie w imieniu pluginu, ale klucza plugin nie widzi),
- nie przekazuje naciśnięć klawiszy z terminala; `terminal:read` dostaje tylko wyjście, a linie po monicie o hasło (echo wyłączone) są wycinane,
- nie pozwala czytać schowka w tle.

## Sekcje w pasku bocznym

Nagłówek sekcji (ikona, nazwa wersalikami, licznik, przyciski akcji) rysuje host, a nie plugin. Dzięki temu każda sekcja zachowuje się tak samo:

- klik w nagłówek zwija sekcję do samej belki z nazwą, a przyciski akcji chowają się razem z treścią,
- stan zwinięcia jest zapamiętywany osobno dla każdej sekcji,
- licznik (`setBadge`) jest widoczny także po zwinięciu,
- `reveal()` rozwija sekcję, np. gdy plugin coś do niej dodał,
- sekcja z `onTabDrop` podświetla się, gdy przeciągasz nad nią zakładkę, i dostaje jej id po upuszczeniu.

Sekcje pluginów stoją nad pozycją „Ustawienia”, w kolejności z Ustawienia → Pluginy. W zwiniętym pasku bocznym zostają same ikony pluginów.

## Izolacja

- Każdy plugin działa we własnym iframe z osobnym originem i CSP bez dostępu do sieci. Sekcje paska bocznego i okna dialogowe pluginu renderują się w jego dokumencie, a host wstrzykuje zmienne motywu (`--background`, `--primary`, `--font-mono`…), więc plugin wygląda jak reszta aplikacji.
- Wszystkie wywołania `tx.*` idą przez `postMessage` do hosta w Ruście, który sprawdza uprawnienia przy każdym wywołaniu.
- Ścieżki w `tx.storage` są względne i nie mogą wyjść poza katalog danych pluginu (`<dane aplikacji>/plugins/<id>/data`).
- Plugin, który rzuci wyjątek w `activate` albo przekroczy limit pamięci, zostaje wyłączony z komunikatem w Ustawieniach. Reszta aplikacji działa dalej.

## Minimalny plugin

```js
// main.js
export function activate(tx) {
  tx.ui.sidebar.registerSection({
    id: 'hello',
    title: 'Hello',
    icon: 'puzzle',
    render(el) {
      el.textContent = tx.config.get('greeting');
    },
  });
}
```

```json
{
  "id": "acme.hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "main.js",
  "permissions": ["ui:sidebar"],
  "contributes": { "sidebar": [{ "id": "hello", "title": "Hello", "icon": "puzzle" }] },
  "config": { "greeting": "Cześć!" }
}
```

## Cykl życia

1. **Import**: walidacja archiwum i manifestu, przegląd uprawnień, rozpakowanie do `plugins/<id>/<wersja>/`. Plugin jest zainstalowany, ale wyłączony.
2. **Włączenie**: host tworzy iframe pluginu, wywołuje `activate(tx)` i rejestruje to, co plugin dodał.
3. **Wyłączenie**: `deactivate()`, potem host usuwa sekcje, elementy paska statusu, pozycje menu i komendy pluginu, oddaje zaparkowane przez niego zakładki do ich workspace'ów i niszczy iframe. Dane pluginu zostają.
4. **Odinstalowanie**: usuwa kod; dane pluginu można zachować albo usunąć.
5. **Zmiana konfiguracji**: `tx.config.onChange` dostaje klucz, który się zmienił.

## Wbudowane pluginy

| Plugin | Co robi | Uprawnienia |
|---|---|---|
| Notatki (`tx.notes`) | Sekcja „Notatki” nad Ustawieniami: foldery w folderach, przeciąganie, każda notatka to plik `.md` z opcjonalnym tytułem w front matter | `storage`, `ui:sidebar`, `ui:commands` |
| Procesy w tle (`tx.bcgrnd_process`) | Sekcja na zakładki z działającym procesem: przeciągnij zakładkę na sekcję albo PPM → „Przenieś do Procesy w tle”. Proces działa dalej, „Przywróć” odkłada zakładkę na jej miejsce, wykrywa też długo działające procesy | `tabs:manage`, `terminal:read`, `ui:sidebar`, `ui:tabmenu` |
| Klucze API (`tx.keys`) | Sekcja z providerami (nazwa i opcjonalny link) i ich kluczami. Klucze są w magazynie poświadczeń systemu, na liście widać pierwsze i ostatnie 4 znaki, ikona obok kopiuje pełny klucz (schowek czyści się po 45 s, jeśli nadal go zawiera). Plugin nie widzi pełnych kluczy | `storage`, `ui:sidebar`, `ui:commands`, `vault:keys` |
| Quota (`tx.quota`) | Plany subskrypcji jak w Orca: procent zużycia i czas do resetu dla zaznaczonych usług (Claude Pro/Max z Claude Code, Codex z Codex CLI, Gemini z Gemini CLI, Cursor, z.ai GLM Coding Plan, OpenCode Go, kredyty OpenRouter); usługa, której nie da się odczytać, znika z paska, a powód widać w ustawieniach. Do tego ile tokenów zostało u providerów zaznaczonych w ustawieniach pluginu (Ustawienia → Pluginy → Quota → Ustawienia albo klik w element paska). Własny limit na dzień lub miesiąc, a bez niego limit API z nagłówków (Anthropic, OpenAI), saldo (OpenRouter, DeepSeek) albo samo zużycie. Górny albo dolny pasek | `storage`, `ui:statusbar`, `ui:commands`, `ai:usage`, `ai:plans` |
| Monitor zasobów (`tx.sysmon`) | CPU i RAM na pasku statusu | `system:info`, `ui:statusbar` |
| Porty (`tx.ports`) | Nasłuchujące porty, otwieranie w przeglądarce, zatrzymywanie procesu | `shell:exec`, `net:localhost`, `ui:sidebar` |
| Pomodoro (`tx.pomodoro`) | Licznik pracy i przerw z powiadomieniem | `ui:statusbar`, `ui:commands`, `notifications` |
