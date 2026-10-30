# Hermitty

Lekki menedżer terminali i workflow z AI dla Windows, Linuksa i macOS. Tauri 2 (Rust) + Svelte 5 + xterm.js. Interfejs po polsku i angielsku.

## Uruchomienie

**Gotowa aplikacja** (po zbudowaniu):

- `release\Hermitty.exe` – uruchamiany bezpośrednio, bez instalacji.
- `release\Hermitty_0.1.0_x64-setup.exe` – instalator dla bieżącego użytkownika (skrót w menu Start, odinstalowanie z ustawień Windows).

**Ze źródeł:**

```powershell
npm install
npm run app:dev      # tryb deweloperski z przeładowaniem
npm run app:build    # wersja release + instalator NSIS
npm run plugins:pack # pluginy z plugins/ → release/plugins/*.zip
npm test             # testy: przepisy modeli vs. definicje nodów ComfyUI, katalog, słowniki
```

Lokalny build release z paczką aktualizacji potrzebuje klucza podpisu: `TAURI_SIGNING_PRIVATE_KEY` (ścieżka do `~/.tauri/terminalx.key` albo jego treść).

**Wydanie**: tag `v*` (np. `git tag v0.2.0 && git push --tags`) uruchamia GitHub Actions, który buduje instalatory dla Windows, Linuksa (AppImage, deb) i macOS (Apple Silicon i Intel), podpisuje paczki aktualizacji i tworzy szkic wydania z `latest.json`. Zainstalowana aplikacja sprawdza aktualizacje po starcie i co 6 godzin; przycisk pojawia się w pasku tytułu. Wersja jest w jednym miejscu: `package.json`.

Wymagania do budowania: Node.js 20+, Rust (rustup, toolchain MSVC), Visual Studio Build Tools z „Desktop development with C++”. WebView2 jest wbudowany w Windows 11.

`npm run dev` uruchamia sam interfejs w przeglądarce z atrapą rdzenia (bez prawdziwych terminali), co przydaje się przy pracy nad wyglądem.

## Co działa

- **Terminale**: PowerShell 7, Windows PowerShell, CMD, każda wykryta dystrybucja WSL, Git Bash. ConPTY, xterm.js z renderowaniem WebGL, kopiowanie i wklejanie (Ctrl+C z zaznaczeniem, Ctrl+V, PPM), wyszukiwanie (Ctrl+Shift+F), podświetlanie słów kluczowych, zapis ekranu do pliku, ponowne uruchomienie po zakończeniu procesu.
- **Panel plików zakładki** (ikona folderu na pasku zakładek albo w belce okna): pliki i foldery bieżącego katalogu terminala, odświeżane po każdej komendzie; dwuklik w folder wpisuje `cd` w terminalu. Katalog zgłasza sama powłoka przy każdym prompcie (PowerShell, CMD, WSL, Git Bash; profil i własny prompt zostają bez zmian).
- **Workspace'y** jako zakładki w pasku tytułu: drag & drop, zmiana nazwy dwuklikiem, kolor.
- **Zakładki**: drag & drop, menu `+` z wyborem rodzaju, menu PPM, podział na dwa panele (poziomo i pionowo, z przeciąganym podziałem), zmiana nazwy (F2 albo dwuklik).
- **Tryb „Okna”**: każda zakładka jako okno. Przesuwanie, zmiana rozmiaru z każdej krawędzi i rogu, maksymalizacja, aktywne na wierzchu, nieaktywne przyciemnione (poziom w Ustawienia → Wygląd), rozmieszczanie kafelkowe.
- **Zamykanie z cofnięciem**: zakładka, workspace, notatka, prompt. Proces działa jeszcze 20 s (czas ustawiany), a „Przywróć” albo Ctrl+Shift+T odkłada element na miejsce.
- **Panele o zmiennej szerokości**: pasek boczny (zwija się do ikon) i panel agenta.
- **Motywy**: 13 wbudowanych (m.in. Ametyst, Retro CRT, Neon, Fiord, Papier, Pastel, Ocean, Monochrom, Zachód) z własnymi czcionkami. Import z tweakcn: link, nazwa, galeria gotowych motywów jednym kliknięciem albo wklejony kod (CSS razem z `layout.tsx`; czcionki z `next/font/google` i zmiennych `--font-*` są pobierane z Google Fonts raz i trzymane lokalnie w folderze `fonts`). Tryb jasny, ciemny i systemowy; paleta terminala liczona z motywu.
- **AI**: providerzy Anthropic, OpenAI, zgodni z OpenAI i Ollama. Klucze w Menedżerze poświadczeń Windows, test połączenia i pobieranie listy modeli, domyślny model.
- **Agent workspace'u i podagenci zakładek**: agent czyta zakładki, uruchamia komendy po zatwierdzeniu, deleguje zadania podagentom (równolegle) i uruchamia workflow. Tryby uprawnień: tylko odczyt, pytaj, automatycznie; lista komend, które zawsze wymagają zgody. Profile i przypisania w Ustawienia → Agenci. Pod polem wiadomości wybór providera i modelu rozmowy (osobno dla każdego workspace'u) z wyszukiwaniem i listą modeli pobraną od providera; można też wpisać własny model. Modele oznaczone gwiazdką są na górze listy (także z innych providerów).
- **Załączniki w czacie**: obrazy, wideo, PDF, pliki tekstowe i kod, inne pliki. Spinacz, przeciągnięcie na panel albo Ctrl+V (zrzut ekranu). Duże obrazy są zmniejszane, z wideo trafia kilka klatek (modele czatu nie przyjmują plików wideo), plik tekstowy idzie jako treść, PDF jako dokument (Anthropic, OpenAI, OpenRouter). Kopie leżą w `attachments/<rozmowa>/`, a agent dostaje ich ścieżki, więc może z nimi pracować w terminalu. Agent może przekazać załączniki podagentowi.
- **Rozmowa wprost z podagentem**: przy polu wiadomości wybierasz adresata (agent albo podagent zakładki); podagent pamięta wątek.
- **Historia rozmów** (ikona zegara w panelu agenta): każda rozmowa z agentem i podagentami zapisuje się sama, z wyszukiwaniem po treści i filtrem workspace'u. Otwarta rozmowa wraca z kontekstem modelu, więc można ją kontynuować; usunięcie kasuje też jej załączniki. Ikona dymku z plusem zaczyna nową rozmowę.
- **Konta i providerzy** (Ustawienia → Konta i providerzy): limity planów subskrypcji (Claude, Codex, Gemini, Cursor, OpenCode Go) z paskami zużycia i czasem do resetu. Claude Code i Codex mogą mieć kilka kont (np. prywatne i firmowe): każde ma własny folder logowania, logujesz się oficjalnym `claude` / `codex login` w zakładce otwartej przez aplikację, a zakładkę terminala przypinasz do konta w jej menu (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, tylko powłoki Windows). Konta nie przełączają się same: regulaminy usług nie pozwalają omijać limitów planu kilkoma kontami.
- **Zastępstwa** (Ustawienia → Zastępstwa): łańcuch providerów API. Gdy provider odpowie limitem (429), brakiem środków (402) albo przeciążeniem (503, 529), zapytanie agenta, snippeta albo noda idzie do następnego z listy, a provider z limitem odpoczywa minutę.
- **Skille** (Ustawienia → Skille): instrukcje do konkretnych zadań w formacie `SKILL.md` z plikami pomocniczymi, tworzone w aplikacji albo importowane z folderu lub .zip. Przypinane profilom agentów i podagentów; model widzi nazwy i opisy, a treść wczytuje narzędziem `use_skill`, gdy jej potrzebuje.
- **Głos** (Ustawienia → Głos): mikrofon w panelu agenta nagrywa wiadomość i zamienia ją na tekst u providera zgodnego z OpenAI (OpenAI, Groq, lokalny Whisper). Tekst trafia do pola wiadomości albo od razu do agenta, a nagranie zostaje w rozmowie do odsłuchania. Odpowiedzi agenta (i opcjonalnie podagentów) mogą być czytane na głos głosami Windows (offline) albo przez `/audio/speech` providera; kod jest pomijany. Mikrofon działa tylko w trakcie nagrywania, a pluginy nie mają do niego dostępu.
- **Serwery MCP** (Ustawienia → Serwery MCP): lokalne (komenda, np. `npx`, `uvx`, z argumentami, zmiennymi i tokenem) i zdalne (Streamable HTTP z nagłówkami i tokenem Bearer). Import konfiguracji z Claude Desktop, Claude Code, Cursora i VS Code. Tokeny w Menedżerze poświadczeń. Serwer startuje przy pierwszym użyciu i kończy się z aplikacją (z całym drzewem procesów). Narzędzia trafiają do agentów i podagentów; w Ustawienia → Agenci wybierasz, które serwery widzi profil. W trybie „pytaj” narzędzia zmieniające coś czekają na zgodę, profil „tylko odczyt” dostaje tylko narzędzia oznaczone jako bezpieczne.
- **Snippety**: komendy i prompty AI ze zmiennymi oraz własnym providerem i modelem (albo domyślnym). Dostępne z Ustawień i z palety komend.
- **Biblioteka promptów**: foldery w folderach, prompty bazowe.
- **Grafika i wideo w workflow** (jak we Florze): nody Generuj obraz, Edytuj obraz, Powiększ, Usuń tło, Generuj wideo, Obraz → wideo, Plik z dysku, Ostatnia klatka i Połącz klipy (te dwa wymagają ffmpeg), Zapisz media. Podgląd wyników w nodzie, podgląd pełnoekranowy, uruchamianie pojedynczego noda. Providerzy: fal.ai i Replicate (setki modeli: Flux, Imagen, Kling, Veo, Seedance, Hailuo…), OpenAI (gpt-image-1, Sora) i Google (Gemini, Imagen, Veo). Każdy node AI widzi obrazy z wejścia (np. „Opisz obraz”). Wyniki trafiają do folderu `media` w danych aplikacji.
- **Lokalne AI** (Ustawienia → Lokalne AI): grafika i wideo na własnej karcie graficznej przez ComfyUI, bez opłat. Instalacja jednym kliknięciem (wersja przenośna dla NVIDIA, AMD i Intel) albo wskazanie istniejącego ComfyUI. Katalog modeli z oceną, czy pasują do komputera (pamięć karty i RAM): Z-Image Turbo, FLUX.2 Klein 4B (także edycja obrazu), SDXL, LTX-Video 2B, Wan 2.1 1.3B, Wan 2.2 5B, BiRefNet (usuwanie tła), SeedVR2 (powiększanie), a dla mocniejszych komputerów Qwen-Image 2512 i Wan 2.2 14B. Pobieranie z postępem i wznawianiem, wspólne pliki pobierają się raz. Własne workflow z ComfyUI (Export (API)) z podstawianiem promptu, obrazu, seeda, proporcji i długości klipu. ComfyUI startuje dopiero, gdy workflow go potrzebuje, i zamyka się po bezczynności (domyślnie 5 min). Zadania lokalne idą przez jedną kolejkę: na karcie jest zawsze jeden model, przed grafiką aplikacja zwalnia modele Ollamy, a przy zmianie modelu pamięć ComfyUI. Kolejność nodów jest układana tak, żeby model zmieniał się jak najrzadziej. W nodzie widać kroki i podgląd generowanego obrazu na żywo. Na Linuksie i macOS instalacja idzie przez `uv` (kod ComfyUI, Python 3.12 i PyTorch dla CUDA, ROCm albo Metal). Zdalny ComfyUI: mocniejszy komputer w sieci albo serwer z GPU w chmurze jako osobny provider. Katalog modeli aktualizuje się z repozytorium (`catalog/models.json`), a pobrane pliki są sprawdzane sumą SHA-256. Ollama (agenci, snippety, nody) i ComfyUI dzielą jedną kolejkę GPU.
- **Workflow**: 50 nodów w 10 kategoriach. Niezmienione nody AI, grafiki i wideo biorą wynik z poprzedniego uruchomienia (Shift + uruchom liczy wszystko od nowa). **Partia**: ten sam workflow dla listy promptów albo folderu obrazów i wideo, po kolei. **Galeria** wyników z promptem, modelem i seedem („powtórz z tym seedem”). Agent workspace'u buduje workflow z opisu słownego (narzędzia `list_node_types` i `build_workflow`). Dalej: i własne nody (także graficzne i wideo), połączenia przeciągane z kropki, ustawienia noda AI (prompt bazowy, prompt dodatkowy, provider i model, tokeny, liczba wyników, format), uruchamianie z podglądem wyników, wyzwalacze cron, git i zmiana pliku działające w tle.
- **Pluginy**: izolowane iframe z uprawnieniami z `plugin.json`, import .zip z przeglądem uprawnień, włączanie i wyłączanie, konfiguracja. Wbudowane: Notatki, Quota (zużycie planów subskrypcji Claude, Codex, Gemini, Cursor, z.ai, OpenCode Go i OpenRouter z logowań narzędzi na tym komputerze, z czasem do resetu; ile tokenów zostało u providerów API: własny limit dzienny lub miesięczny, limity API z nagłówków, saldo OpenRouter/DeepSeek; na górnym albo dolnym pasku), Klucze API (providerzy z opcjonalnym linkiem i wieloma kluczami; klucze w Menedżerze poświadczeń, na liście częściowo ukryte, kopiowanie jednym kliknięciem), Procesy w tle (zaparkowane zakładki zostają z prawej strony paska zakładek: klik pokazuje terminal, dwuklik przywraca), Monitor zasobów, Porty, Pomodoro. Specyfikacja: [docs/PLUGINS.md](docs/PLUGINS.md).
- **SSH i Vault hostów** (pasek boczny → Hosty): siatka, lista i drzewo grup, wyszukiwarka, tagi, wykrywanie dystrybucji. Logowanie hasłem, kluczem (hasła w Menedżerze poświadczeń) albo przez agenta SSH (OpenSSH agent, Pageant, `SSH_AUTH_SOCK`), generator kluczy ed25519, potwierdzenie odcisku klucza hosta przy pierwszym połączeniu i ostrzeżenie przy jego zmianie. Zakładka SSH działa jak terminal, więc agent, snippety, podział i Procesy w tle obsługują też SSH.
- **SFTP**: dwa panele (komputer i serwer), przeciąganie plików i całych folderów między nimi, postęp transferu, nowy folder, zmiana nazwy, usuwanie (foldery z zawartością), edycja plików tekstowych na serwerze.
- **Przekierowania portów**: lokalne (-L), zdalne (-R) i SOCKS (-D), z automatycznym startem przy połączeniu.
- **Zdalny dostęp z telefonu** (Ustawienia → Zdalny dostęp): w sieci Wi-Fi albo przez Tailscale (z dowolnego miejsca, bez publicznego IP). Parowanie kodem QR z potwierdzeniem na komputerze, szyfrowanie każdej wiadomości kluczem urządzenia, uprawnienia per urządzenie (podgląd, sterowanie, pełny). Telefon w przeglądarce: terminale na żywo z paskiem klawiszy, czat z agentem i zatwierdzanie komend, Procesy w tle.
- **Monitoring** (pasek boczny): CPU z wykresem, RAM, dysk, sieć, GPU (NVIDIA) i opóźnienie dla tego komputera i wybranych hostów SSH (Linux, odczyt `/proc` przez istniejące połączenie, bez agenta na serwerze). Kolumny i odświeżanie do wyboru; odpytuje tylko przy otwartej zakładce.
- **Eksplorator i wiersz poleceń**: „Otwórz w Hermitty” w menu folderu (instalator; w wersji portable przełącznik w Ustawienia → Ogólne), `--open-terminal-path <folder>` i `--open-terminal-shell <powłoka>`. Kolejne uruchomienie otwiera terminal w działającej kopii.
- **Język**: polski albo angielski (automatycznie z systemu, zmiana w Ustawienia → Ogólne). Słowniki w `src/lib/i18n/`.
- **Paleta komend** (Ctrl+K), zapamiętywanie układu i sesji, tryb portable (folder `data` obok exe).

## Zużycie zasobów

Instalator ma około 3 MB, a plik exe 8,5 MB. Pamięć (prywatna, rdzeń i WebView2, bez samych powłok) wynosi około 95 MB z jednym terminalem i około 150 MB z trzema. Domyślny „Tryb lekki” (Ustawienia → Ogólne) wyłącza GPU w WebView2. Bez niego zużycie rośnie do około 210 MB, w zamian za płynniejsze przewijanie bardzo dużego wyjścia.

## Czego jeszcze nie ma

- **Grafika i wideo**: adaptery providerów są sprawdzone na atrapie API, nie na prawdziwych kluczach. Nazwy pól wejściowych różnią się między modelami; gdy model nie przyjmie obrazu, ustaw „Pole obrazu wejściowego” albo „Parametry modelu (JSON)” w zaawansowanych ustawieniach noda.
- **Lokalne AI**: przepisy modeli są sprawdzone względem definicji nodów ComfyUI 0.43 i na atrapie serwera (kolejka, podgląd, błędy, zwalnianie pamięci), ale nie były jeszcze uruchomione na prawdziwych modelach. Czasy generowania zależą od karty; przy 16 GB RAM większe modele wideo mocno korzystają z dysku. Instalacja przez `uv` na Linuksie i macOS nie była jeszcze uruchomiona na tych systemach.
- **Zdalny dostęp P2P bez Tailscale** (iroh): wymaga natywnej aplikacji mobilnej (Tauri 2 na Android/iOS), której tu nie zbudowano.
- **Agent SSH**: zaimplementowany, ale nie testowany z prawdziwym agentem (Pageant, OpenSSH).
- **Plany subskrypcji w Quota**: korzystają z nieoficjalnych endpointów usług (tych samych co ich własne narzędzia), więc mogą przestać działać po zmianie po stronie usługi. Parsowanie odpowiedzi jest przetestowane na przykładach; z prawdziwymi kontami sprawdzony tylko format OpenRouter.
- **MCP**: obsługiwane są serwery stdio i Streamable HTTP; starszy transport HTTP+SSE (osobny adres `/sse`) i logowanie OAuth do serwerów zdalnych jeszcze nie. Zasoby i prompty MCP nie są używane, tylko narzędzia.
- **Tłumaczenie**: teksty składane w kodzie z wielu części mogą zostać po polsku; słownik uzupełnia się w `src/lib/i18n/en.json`.
- **Podpis kodu Windows**: instalator nie ma certyfikatu, więc SmartScreen pokaże ostrzeżenie przy pierwszym uruchomieniu.
- Zdalny dostęp w sieci Wi-Fi działa po HTTP (treść jest szyfrowana kluczem urządzenia, ale strona klienta przychodzi bez TLS, więc ktoś w tej samej sieci mógłby ją podmienić przy kolejnym otwarciu). W Tailscale ruch jest dodatkowo szyfrowany przez WireGuard.
- Paleta komend nie ma jeszcze edycji skrótów, a po restarcie aplikacji zakładki uruchamiają świeże powłoki (historia ekranu nie jest zapisywana).

## Struktura

```
src/                 interfejs (Svelte 5)
  lib/terminal/      sesje xterm.js + PTY
  lib/plugins/       host pluginów i środowisko w iframe
  lib/workflow/      edytor i silnik workflow, przepisy modeli (presets.ts), ComfyUI, budowanie przez agenta
  lib/gpu.ts         kolejka GPU (ComfyUI + Ollama)
  lib/i18n/          słowniki tłumaczeń
  lib/components/    widoki, ustawienia
src-tauri/src/       rdzeń w Ruście: pty.rs, sys.rs, store.rs, ai.rs, media.rs, local.rs (ComfyUI, pobieranie, sprzęt), monitor.rs, ssh.rs
catalog/             katalog modeli lokalnych pobierany przez aplikację
tests/               testy (npm test)
.github/workflows/   CI i wydania
plugins/             wbudowane pluginy + sdk/hermitty-plugin.d.ts
docs/PLUGINS.md      specyfikacja pluginów
PLAN.md              plan i architektura
```
