# TerminalX

Lekki menedżer terminali i workflow z AI dla Windows (później Linux i macOS). Tauri 2 (Rust) + Svelte 5 + xterm.js.

## Uruchomienie

**Gotowa aplikacja** (po zbudowaniu):

- `release\TerminalX.exe` – uruchamiany bezpośrednio, bez instalacji.
- `release\TerminalX_0.1.0_x64-setup.exe` – instalator dla bieżącego użytkownika (skrót w menu Start, odinstalowanie z ustawień Windows).

**Ze źródeł:**

```powershell
npm install
npm run app:dev      # tryb deweloperski z przeładowaniem
npm run app:build    # wersja release + instalator NSIS
npm run plugins:pack # pluginy z plugins/ → release/plugins/*.zip
```

Wymagania do budowania: Node.js 20+, Rust (rustup, toolchain MSVC), Visual Studio Build Tools z „Desktop development with C++”. WebView2 jest wbudowany w Windows 11.

`npm run dev` uruchamia sam interfejs w przeglądarce z atrapą rdzenia (bez prawdziwych terminali), co przydaje się przy pracy nad wyglądem.

## Co działa

- **Terminale**: PowerShell 7, Windows PowerShell, CMD, każda wykryta dystrybucja WSL, Git Bash. ConPTY, xterm.js z renderowaniem WebGL, kopiowanie i wklejanie (Ctrl+C z zaznaczeniem, Ctrl+V, PPM), wyszukiwanie (Ctrl+Shift+F), podświetlanie słów kluczowych, zapis ekranu do pliku, ponowne uruchomienie po zakończeniu procesu.
- **Workspace'y** jako zakładki w pasku tytułu: drag & drop, zmiana nazwy dwuklikiem, kolor.
- **Zakładki**: drag & drop, menu `+` z wyborem rodzaju, menu PPM, podział na dwa panele (poziomo i pionowo, z przeciąganym podziałem), zmiana nazwy (F2 albo dwuklik).
- **Tryb „Okna”**: każda zakładka jako okno. Przesuwanie, zmiana rozmiaru z każdej krawędzi i rogu, maksymalizacja, aktywne na wierzchu, nieaktywne przyciemnione (poziom w Ustawienia → Wygląd), rozmieszczanie kafelkowe.
- **Zamykanie z cofnięciem**: zakładka, workspace, notatka, prompt. Proces działa jeszcze 20 s (czas ustawiany), a „Przywróć” albo Ctrl+Shift+T odkłada element na miejsce.
- **Panele o zmiennej szerokości**: pasek boczny (zwija się do ikon) i panel agenta.
- **Motywy**: 13 wbudowanych (m.in. Ametyst, Retro CRT, Neon, Fiord, Papier, Pastel, Ocean, Monochrom, Zachód) z własnymi czcionkami. Import z tweakcn: link, nazwa, galeria gotowych motywów jednym kliknięciem albo wklejony kod (CSS razem z `layout.tsx`; czcionki z `next/font/google` i zmiennych `--font-*` są pobierane z Google Fonts raz i trzymane lokalnie w folderze `fonts`). Tryb jasny, ciemny i systemowy; paleta terminala liczona z motywu.
- **AI**: providerzy Anthropic, OpenAI, zgodni z OpenAI i Ollama. Klucze w Menedżerze poświadczeń Windows, test połączenia i pobieranie listy modeli, domyślny model.
- **Agent workspace'u i podagenci zakładek**: agent czyta zakładki, uruchamia komendy po zatwierdzeniu, deleguje zadania podagentom (równolegle) i uruchamia workflow. Tryby uprawnień: tylko odczyt, pytaj, automatycznie; lista komend, które zawsze wymagają zgody. Profile i przypisania w Ustawienia → Agenci.
- **Snippety**: komendy i prompty AI ze zmiennymi oraz własnym providerem i modelem (albo domyślnym). Dostępne z Ustawień i z palety komend.
- **Biblioteka promptów**: foldery w folderach, prompty bazowe.
- **Grafika i wideo w workflow** (jak we Florze): nody Generuj obraz, Edytuj obraz, Powiększ, Usuń tło, Generuj wideo, Obraz → wideo, Plik z dysku, Ostatnia klatka i Połącz klipy (te dwa wymagają ffmpeg), Zapisz media. Podgląd wyników w nodzie, podgląd pełnoekranowy, uruchamianie pojedynczego noda. Providerzy: fal.ai i Replicate (setki modeli: Flux, Imagen, Kling, Veo, Seedance, Hailuo…), OpenAI (gpt-image-1, Sora) i Google (Gemini, Imagen, Veo). Każdy node AI widzi obrazy z wejścia (np. „Opisz obraz”). Wyniki trafiają do folderu `media` w danych aplikacji.
- **Lokalne AI** (Ustawienia → Lokalne AI): grafika i wideo na własnej karcie graficznej przez ComfyUI, bez opłat. Instalacja jednym kliknięciem (wersja przenośna dla NVIDIA, AMD i Intel) albo wskazanie istniejącego ComfyUI. Katalog modeli z oceną, czy pasują do komputera (pamięć karty i RAM): Z-Image Turbo, FLUX.2 Klein 4B (także edycja obrazu), SDXL, LTX-Video 2B, Wan 2.1 1.3B, Wan 2.2 5B, BiRefNet (usuwanie tła), SeedVR2 (powiększanie), a dla mocniejszych komputerów Qwen-Image 2512 i Wan 2.2 14B. Pobieranie z postępem i wznawianiem, wspólne pliki pobierają się raz. Własne workflow z ComfyUI (Export (API)) z podstawianiem promptu, obrazu, seeda, proporcji i długości klipu. ComfyUI startuje dopiero, gdy workflow go potrzebuje, i zamyka się po bezczynności (domyślnie 5 min). Zadania lokalne idą przez jedną kolejkę: na karcie jest zawsze jeden model, przed grafiką aplikacja zwalnia modele Ollamy, a przy zmianie modelu pamięć ComfyUI. Kolejność nodów jest układana tak, żeby model zmieniał się jak najrzadziej. W nodzie widać kroki i podgląd generowanego obrazu na żywo.
- **Workflow**: 50 nodów w 10 kategoriach i własne nody (także graficzne i wideo), połączenia przeciągane z kropki, ustawienia noda AI (prompt bazowy, prompt dodatkowy, provider i model, tokeny, liczba wyników, format), uruchamianie z podglądem wyników, wyzwalacze cron, git i zmiana pliku działające w tle.
- **Pluginy**: izolowane iframe z uprawnieniami z `plugin.json`, import .zip z przeglądem uprawnień, włączanie i wyłączanie, konfiguracja. Wbudowane: Notatki, Procesy w tle, Monitor zasobów, Porty, Pomodoro. Specyfikacja: [docs/PLUGINS.md](docs/PLUGINS.md).
- **SSH i Vault hostów** (pasek boczny → Hosty): siatka, lista i drzewo grup, wyszukiwarka, tagi, wykrywanie dystrybucji. Logowanie hasłem albo kluczem (hasła w Menedżerze poświadczeń), generator kluczy ed25519, potwierdzenie odcisku klucza hosta przy pierwszym połączeniu i ostrzeżenie przy jego zmianie. Zakładka SSH działa jak terminal, więc agent, snippety, podział i Procesy w tle obsługują też SSH.
- **SFTP**: dwa panele (komputer i serwer), przeciąganie między nimi, postęp transferu, nowy folder, zmiana nazwy, usuwanie, edycja plików tekstowych na serwerze.
- **Przekierowania portów**: lokalne (-L), zdalne (-R) i SOCKS (-D), z automatycznym startem przy połączeniu.
- **Zdalny dostęp z telefonu** (Ustawienia → Zdalny dostęp): w sieci Wi-Fi albo przez Tailscale (z dowolnego miejsca, bez publicznego IP). Parowanie kodem QR z potwierdzeniem na komputerze, szyfrowanie każdej wiadomości kluczem urządzenia, uprawnienia per urządzenie (podgląd, sterowanie, pełny). Telefon w przeglądarce: terminale na żywo z paskiem klawiszy, czat z agentem i zatwierdzanie komend, Procesy w tle.
- **Paleta komend** (Ctrl+K), zapamiętywanie układu i sesji, tryb portable (folder `data` obok exe).

## Zużycie zasobów

Instalator ma 2 MB, a plik exe 4,9 MB. Pamięć (prywatna, rdzeń i WebView2, bez samych powłok) wynosi około 95 MB z jednym terminalem i około 150 MB z trzema. Domyślny „Tryb lekki” (Ustawienia → Ogólne) wyłącza GPU w WebView2. Bez niego zużycie rośnie do około 210 MB, w zamian za płynniejsze przewijanie bardzo dużego wyjścia.

## Czego jeszcze nie ma

- **Monitoring hostów** (faza 6).
- **Grafika i wideo**: adaptery providerów są sprawdzone na atrapie API, nie na prawdziwych kluczach. Nazwy pól wejściowych różnią się między modelami; gdy model nie przyjmie obrazu, ustaw „Pole obrazu wejściowego” albo „Parametry modelu (JSON)” w zaawansowanych ustawieniach noda.
- **Lokalne AI**: przepisy modeli są sprawdzone względem definicji nodów ComfyUI 0.43 i na atrapie serwera (kolejka, podgląd, błędy, zwalnianie pamięci), ale nie były jeszcze uruchomione na prawdziwych modelach. Czasy generowania zależą od karty; przy 16 GB RAM większe modele wideo mocno korzystają z dysku. Automatyczna instalacja ComfyUI jest tylko dla Windows (na Linuksie i macOS wskaż własną instalację). Agenci korzystający z Ollamy nie czekają w kolejce GPU (tylko nody workflow).
- **Zdalny dostęp P2P bez Tailscale** (iroh): wymaga natywnej aplikacji mobilnej (Tauri 2 na Android/iOS), której tu nie zbudowano.
- **SFTP**: przenoszenie całych folderów (pliki pojedynczo działają). Uwierzytelnianie przez agenta SSH (Pageant/OpenSSH agent).
- Zdalny dostęp w sieci Wi-Fi działa po HTTP (treść jest szyfrowana kluczem urządzenia, ale strona klienta przychodzi bez TLS, więc ktoś w tej samej sieci mógłby ją podmienić przy kolejnym otwarciu). W Tailscale ruch jest dodatkowo szyfrowany przez WireGuard.
- Paleta komend nie ma jeszcze edycji skrótów, a po restarcie aplikacji zakładki uruchamiają świeże powłoki (historia ekranu nie jest zapisywana).

## Struktura

```
src/                 interfejs (Svelte 5)
  lib/terminal/      sesje xterm.js + PTY
  lib/plugins/       host pluginów i środowisko w iframe
  lib/workflow/      edytor i silnik workflow
  lib/components/    widoki, ustawienia
src-tauri/src/       rdzeń w Ruście: pty.rs, sys.rs, store.rs, ai.rs, media.rs, local.rs (ComfyUI, pobieranie, sprzęt)
plugins/             wbudowane pluginy + sdk/terminalx-plugin.d.ts
docs/PLUGINS.md      specyfikacja pluginów
PLAN.md              plan i architektura
```
