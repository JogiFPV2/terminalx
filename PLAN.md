# TerminalX: plan projektu

Lekki, minimalistyczny menedżer terminali i workflow z AI, wzorowany wizualnie na [Netcatty](https://github.com/binaricat/Netcatty).
Najpierw Windows, potem Linux i macOS.

---

## Stan (28.10.2026)

Zbudowana i przetestowana wersja 0.1.0: `release/TerminalX.exe` (4,9 MB) i instalator `release/TerminalX_0.1.0_x64-setup.exe` (2 MB).

| Faza | Stan |
|---|---|
| 0. Fundament i design | gotowe |
| 1. Terminale (PowerShell, pwsh, CMD, WSL, Git Bash) | gotowe |
| 2. Workspaces, okna, zamykanie z cofnięciem, zapis sesji | gotowe |
| 2.5. Pluginy (host, import .zip, 5 wbudowanych) | gotowe |
| 3. AI (providerzy, agent i podagenci, prompty, snippety) | gotowe; przetestowane bez klucza API (ścieżka błędu), rozmowy z modelem nie testowano |
| 4. SSH, SFTP, Vault, port forwarding | gotowe (przetestowane na testowym serwerze russh) |
| 5. Workflow | gotowe (39 nodów, własne nody, wyzwalacze cron/git/plik) |
| 6. Monitoring hostów | do zrobienia |
| 7. Zdalny dostęp z telefonu | gotowe w trybach Wi-Fi i Tailscale; P2P (iroh) czeka na aplikację mobilną |
| 8. Dystrybucja (auto-update, Eksplorator, Linux/macOS) | częściowo: instalator NSIS i tryb portable gotowe |

**Odstępstwa od planu**
- Zamiast Tailwind i shadcn-svelte jest czysty CSS z tymi samymi tokenami (tweakcn działa bez zmian).
- Edytor workflow jest własny (bez Svelte Flow), więc paczka jest mniejsza.
- Stan aplikacji jest w `state.json` zamiast SQLite.

**Pamięć RAM** (pamięć prywatna, rdzeń i WebView2, bez samych powłok): około 95 MB z jednym terminalem, około 150 MB z trzema terminalami w trybie okien. Pomiar w „Trybie lekkim” (domyślnym), czyli WebView2 bez GPU i terminal z rendererem DOM. Z GPU było to około 210 MB.

---

## 1. Stack

| Warstwa | Wybór | Dlaczego |
|---|---|---|
| Powłoka aplikacji | **Tauri 2** (Rust) | Instalator ~6–12 MB zamiast ~100+ MB w Electronie (Netcatty). Używa systemowego WebView2 (Win), WebKit (macOS), WebKitGTK (Linux), więc nie wozi Chromium. Jeden kod na 3 systemy. |
| Rdzeń / backend | **Rust + tokio** | Stabilność, brak GC, niskie zużycie RAM. Cały stan (sesje, PTY, agenci) żyje tutaj. |
| PTY (terminale) | **portable-pty** (ConPTY na Windows) | To samo co WezTerm. PowerShell 5.1, pwsh 7, CMD, WSL (autodetekcja dystrybucji przez `wsl -l -q`). |
| UI | **Svelte 5 + TypeScript + Vite** | Kompilowany, bez virtual DOM, najmniejszy bundle i narzut RAM spośród popularnych frameworków. |
| Komponenty | **shadcn-svelte** (bits-ui) + **Tailwind CSS 4** + **lucide** | Ten sam system tokenów co shadcn/ui, więc motywy z **tweakcn** działają 1:1. |
| Emulator terminala | **xterm.js 5** + addon **WebGL**, fit, search, unicode11, web-links, (później image: Sixel/Kitty) | To samo co Netcatty/VS Code. Renderowanie GPU. |
| Edytor workflow | **Svelte Flow** (@xyflow/svelte) | Oficjalny port React Flow. Nody, krawędzie, minimapa. |
| Dane | **SQLite** (rusqlite) + config w TOML | Workspaces, hosty, snippety, historia. |
| Sekrety | crate **keyring** | Windows Credential Manager / macOS Keychain / Secret Service. Klucze API i hasła nigdy w plikach. |
| SSH / SFTP (później) | **russh** + russh-sftp | Czysty Rust, bez OpenSSL. |
| Zdalne sterowanie (później) | **axum** + WebSocket, wbudowany serwer, domyślnie wyłączony | Ten sam protokół co lokalny UI. |

**Uczciwie o RAM:** największy koszt to WebView2 (~60–100 MB). Natywne GUI (egui/GPUI) zeszłoby do ~30–50 MB, ale stracilibyśmy motywy tweakcn, edytor workflow i tempo pracy. Tauri to najlepszy kompromis „lekko + ładnie + cross-platform”.

### Budżety wydajności (pilnowane w CI)

| Metryka | Cel |
|---|---|
| Instalator (NSIS/MSI) | ≤ 12 MB |
| RAM w spoczynku, 1 terminal | ≤ 120 MB (całe drzewo procesów) |
| Każdy kolejny terminal | + ≤ 8 MB |
| Zimny start do pierwszej klatki | ≤ 400 ms |
| Opóźnienie klawisz → echo | ≤ 10 ms |
| CPU w spoczynku | ~0% (zero pollingu, wszystko eventowe) |

Techniki: batching wyjścia PTY (paczki co ~4 ms przez Tauri Channels, binarnie), nieaktywne zakładki odpinają renderer WebGL (zostaje bufor), lazy-load modułów (workflow, SFTP, monitoring ładują się dopiero przy pierwszym otwarciu), limit scrollbacku konfigurowalny.

---

## 2. Architektura

```
┌──────────────── Rust core (proces główny) ────────────────┐
│  SessionHub ── PTY manager (ConPTY)                        │
│      │      └─ (później) SSH / Telnet / Serial             │
│  WorkspaceStore (SQLite)      ThemeEngine (tweakcn)        │
│  AgentBus ── Agent workspace'u ⇄ Podagenci zakładek        │
│      └─ Providerzy: Anthropic / OpenAI / Ollama (lokalnie) │
│  WorkflowEngine (DAG executor)                             │
│  Gateway (protokół zdarzeń) ──┬── lokalne okno (Tauri IPC) │
│                               └── zdalni klienci (WS, TLS) │
└────────────────────────────────────────────────────────────┘
```

**Kluczowa decyzja:** okno aplikacji to tylko *klient* rdzenia. Wszystkie akcje (otwórz zakładkę, wpisz do terminala, uruchom workflow, napisz do agenta) idą jednym protokołem komend i zdarzeń. Dzięki temu zdalne sterowanie z telefonu czy innego komputera to „drugi klient tego samego protokołu”, a nie przepisywanie aplikacji. Ten sam protokół daje agentom AI narzędzia do sterowania aplikacją.

### Model danych

```
Workspace { id, name, icon, color, agent: AgentConfig, mode: tabs|windows, zOrder[], tabs[] }
Tab       { id, kind: terminal|workflow|sftp|monitor, title, subagent?: SubagentConfig,
            window: { x, y, w, h, maximized } }   // geometria dla trybu „Okna”
UiLayout  { sidebarWidth, agentWidth, agentOpen, inactiveWindowDim }
Provider  { id, type: anthropic|openai|compat|ollama, name, baseUrl, keyRef, models[] }
AgentProfile { id, kind: agent|sub, name, provider, model, permission: read|ask|auto, tools[], systemPrompt, maxParallel? }
Snippet   { id, name, kind: cmd|ai, body, provider?, model? }      // brak = domyślny model
Plugin    { id, version, enabled, grantedPermissions[], config{} }
PendingClose { id, kind: tab|workspace|note, snapshot, expiresAt }
PromptNode { id, kind: folder|prompt, parentId?, name, body?, model? }
NodeType  { id, category, name, icon, ai, fields[] | aiDefaults{ basePromptId?, prompt, provider?, model?, temperature, maxTokens, topP, results, format } }
FlowNode  { id, typeId, x, y, label?, config{} }        Flow { nodes[], edges[[from,to]] }
ParkedTab { tabId, workspaceId, index, parkedBy: pluginId }
RemoteDevice { id, name, publicKey, permission: view|control|full, lastSeen }
Terminal  { shell: powershell|pwsh|cmd|wsl:<distro>|ssh:<host>, cwd, env, splits }
```

---

## 3. Wygląd i UX (najważniejsze)

Kierunek: Netcatty, ale jeszcze ciszej. Ciemny domyślnie, płaskie powierzchnie, cienkie obramowania 1px zamiast cieni, jeden kolor akcentu z motywu, ikony lucide 16px, gęsty układ.

```
┌──────────────────────────────────────────────────────────────────┐
│ ◆  [Backend ×] [Infra ×] [Projekt AI ×]  +        ◉ AI  ⚙  ─ □ ✕ │  pasek tytułu = zakładki workspace'ów
├──┬───────────────────────────────────────────────┬───────────────┤
│▣ │ [PS api ●] [WSL ubuntu ●] [CMD] [⎔ Deploy] +  │ Agent: Backend│  zakładki w workspace (● = podagent)
│⌂ ├───────────────────────────────────────────────┤ ──────────────│
│⎔ │ PS C:\dev\api> npm run dev                    │ podagenci:    │
│✂ │ > vite ready in 312 ms                        │  ● PS api     │
│  │ ─────────────── split ───────────────         │  ● WSL ubuntu │
│  │ user@ubuntu:~$ docker ps                      │ [czat]        │
│⚙ │                                               │ [ wpisz… ]    │
├──┴───────────────────────────────────────────────┴───────────────┤
│ pwsh 7.5 · C:\dev\api · UTF-8          podagent: bezczynny · 84 MB│  pasek statusu
└──────────────────────────────────────────────────────────────────┘
```

- **Pasek tytułu (36 px)** bez ramki systemowej: logo, zakładki workspace'ów (drag & drop w lewo/prawo, kolorowa kropka), `+`, przełącznik panelu AI, ustawienia, własne przyciski okna (na macOS natywne „światła”).
- **Pasek boczny (zmienna szerokość 44–320 px)**: zwinięty pokazuje same ikony, od 140 px etykiety i listę zakładek workspace'u. Poniżej ~90 px zatrzaskuje się do 44 px, dwuklik na krawędzi zwija/rozwija.
- **Pasek zakładek workspace'u (34 px)**: ikona typu (PS/CMD/WSL/Workflow), tytuł, kropka statusu podagenta. Drag & drop w lewo/prawo, środkowy klik zamyka. `+` otwiera menu rodzaju zakładki: PowerShell 7, Windows PowerShell 5.1, CMD, każda wykryta dystrybucja WSL, Workflow, a w kolejnych fazach SSH, SFTP, Monitoring. Lista budowana z rejestru typów zakładek, więc nowy typ to jeden wpis.
- **Przełącznik układu workspace'u: Zakładki / Okna**
  - *Zakładki*: jedna zakładka na raz, splity poziome i pionowe z przeciąganym podziałem.
  - *Okna*: każda zakładka to pływające okno w obszarze workspace'u. Przesuwanie za pasek tytułu, zmiana rozmiaru za 4 krawędzie i 4 rogi, dwuklik maksymalizuje, przycisk „rozmieść kafelkowo”. Aktywne okno zawsze na wierzchu i w 100% jasności, nieaktywne przyciemnione do 60% (suwak w Ustawieniach). Pozycje i rozmiary zapisywane per workspace.
- **Panel agenta (prawy, chowany, zmienna szerokość 240–560 px)**: agent workspace'u, lista podagentów ze statusem, czat, zatwierdzanie komend.
- Rozmiary paneli i podziałów zapisywane w ustawieniach i przywracane przy starcie.
- **Pasek statusu (24 px)**: powłoka, cwd, kodowanie, status podagenta, zużycie RAM.
- **Paleta komend** (Ctrl+K): wszystko dostępne z klawiatury.
- **Mikroruchy**: 120–160 ms, tylko opacity/transform, wyłączane przy `prefers-reduced-motion`.
- **Sekcje pluginów w pasku bocznym**: nad „Ustawieniami”, każda z nagłówkiem (strzałka, ikona, nazwa wersalikami, licznik, przyciski akcji). Klik w nagłówek zwija sekcję do samej belki z nazwą; stan zapamiętywany per plugin. Nagłówek rysuje host, więc wszystkie pluginy zachowują się identycznie. W zwiniętym pasku zostają ikony pluginów; kliknięcie rozwija pasek.
- **Menu kontekstowe zakładki (PPM)**: Duplikuj, Podziel panel, pozycje dodane przez pluginy (np. „Przenieś do Procesy w tle”), Zamknij.
- **Przeciąganie zakładki poza pasek**: ruch w poziomie zmienia kolejność, pociągnięcie w dół „odrywa” zakładkę i pozwala upuścić ją na sekcję pluginu, która przyjmuje zakładki.

### Zamykanie z cofnięciem

Zamknięcie zakładki, workspace'u, notatki albo folderu niczego nie niszczy od razu:
- Element znika z widoku, a w prawym dolnym rogu pojawia się powiadomienie z przyciskiem „Przywróć”, licznikiem sekund i paskiem postępu. Kilka powiadomień układa się w stos.
- Przez 20 s (konfigurowalne w Ustawienia → Ogólne, 5–60 s) proces terminala dalej działa, a jego wyjście jest buforowane, więc po przywróceniu niczego nie brakuje.
- „Przywróć” lub Ctrl+Shift+T wstawia element w to samo miejsce, z tym samym układem okien, splitów i podagentem.
- Po upływie czasu rdzeń kończy proces (najpierw łagodnie, po 2 s na twardo) i zwalnia pamięć.
- Zamknięcie aplikacji finalizuje wszystkie oczekujące zamknięcia.
- To samo API (`storage.trash`) dostają pluginy, żeby ich usuwanie działało identycznie.

### Motywy z tweakcn

tweakcn eksportuje motywy jako zmienne CSS shadcn (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--sidebar-*`, `--chart-1..5`, `--radius`, fonty, cienie) w wariantach light i dark. Rejestr: `https://tweakcn.com/r/themes/<nazwa>.json` (`cssVars.theme / light / dark`).

W ustawieniach → Wygląd:
1. Galeria wbudowanych motywów (podgląd na żywo, miniatury).
2. **Import z tweakcn**: wklej link (`tweakcn.com/r/themes/...` lub link edytora) albo wklej blok CSS `:root { … } .dark { … }`. Rdzeń pobiera i waliduje JSON, zapisuje do `themes/*.json`.
3. Tryb: jasny / ciemny / systemowy.
4. **Paleta terminala wyprowadzana z motywu** (tło = `--background`, kursor = `--primary`, ANSI 16 kolorów dobrane z `--chart-*` i `--destructive`), z możliwością nadpisania osobnym schematem (np. importowanym z iTerm2 / Windows Terminal).
5. Font terminala, rozmiar, interlinia, ligatury.

---

## 4. AI: agent i podagenci

- **Agent workspace'u („szef”)**: widzi wszystkie zakładki, deleguje zadania, sprawdza wyniki, raportuje użytkownikowi.
- **Podagent zakładki**: przypięty do jednego terminala. Ma narzędzia `read_buffer`, `run_command`, `wait_for_output`, `report`.
- **Komunikacja**: AgentBus w Ruście (kanały tokio). Agent ↔ podagent przez wiadomości typu `task`, `progress`, `result`, `question`. Wszystko widoczne w panelu (przejrzystość).
- **Bezpieczeństwo**: tryby uprawnień na zakładkę: *tylko odczyt* / *pytaj przed komendą* (domyślnie) / *auto*. Lista komend zawsze wymagających zgody (`rm -rf`, `format`, `Remove-Item -Recurse`…).
- Koszt i tokeny widoczne per workspace.

### Ustawienia → Agenci

- **Profile agentów** (szefów) i **profile podagentów**: tworzenie, edycja, usuwanie. Każdy profil ma nazwę, providera i model, tryb uprawnień (tylko odczyt / pytaj / auto), listę narzędzi i instrukcję systemową. Agent ma też limit równoległych podagentów.
- Wbudowane profile na start: „Szef (domyślny)”, „DevOps”, „Podagent terminala”, „Obserwator (tylko odczyt)”.
- **Przypisania**: tabela workspace → agent oraz domyślny profil podagenta dla nowych zakładek (albo „brak”). Pojedyncza zakładka może go nadpisać z menu kontekstowego.

### Ustawienia → Providerzy

- Lista providerów: Anthropic, OpenAI, dowolny zgodny z OpenAI (OpenRouter, LM Studio, Groq…), Ollama lokalnie. Dodawanie, edycja, usuwanie, „Testuj połączenie” (pobiera też listę modeli).
- Klucz API trafia wyłącznie do systemowego magazynu (Windows Credential Manager / Keychain / Secret Service). W plikach konfiguracji jest tylko odwołanie.
- **Domyślny model** globalnie (na start `claude-sonnet-5-5`), używany przez agentów, snippety i workflow, które nie mają własnego wyboru. Sugerowane: szef `claude-opus-5-5`, podagenci `claude-sonnet-5-5`, streszczenia `claude-haiku-5-5`.

### Ustawienia → Prompty (biblioteka promptów bazowych)

- Drzewo folderów (foldery w folderach) z licznikiem promptów. W każdym folderze można tworzyć prompty bazowe i podfoldery.
- Edytor: nazwa, folder, treść ze zmiennymi `{{input}}` (wynik poprzedniego kroku) i dowolnymi `{{nazwa}}` (uzupełniane przy uruchomieniu). Widać, w ilu nodach i typach nodów prompt jest używany.
- Usuwanie z 20-sekundowym cofnięciem.
- Z biblioteki korzystają: nody AI w workflow, własne typy nodów, snippety AI i profile agentów.
- Na dysku: `prompts/<folder>/<nazwa>.md` z front matter (id, opcjonalny model). Łatwe do wersjonowania w git i do synchronizacji.

### Ustawienia → Snippety

- Lista wszystkich snippetów z wyszukiwarką, tworzenie, edycja, usuwanie. Ten sam zbiór jest dostępny z paska bocznego, palety komend (Ctrl+K) i menu kontekstowego terminala.
- Rodzaj: **komenda** (wstawiana do terminala) albo **prompt AI** (wynik w panelu agenta lub wstawiony do terminala).
- Każdy snippet ma pole provider + model z opcją „Domyślny”, więc działa od razu, a w razie potrzeby można przypiąć konkretny model.
- Zmienne: `{{selection}}`, `{{cwd}}`, `{{last_output:N}}`, `{{cmd:…}}` (wynik komendy), `{{nazwa}}` (pytanie przy uruchomieniu).

---

## 5. Pluginy

Pełna specyfikacja: [`docs/PLUGINS.md`](docs/PLUGINS.md), typy API: [`plugins/sdk/terminalx-plugin.d.ts`](plugins/sdk/terminalx-plugin.d.ts).

- Plugin to folder z `plugin.json` i modułem JS, spakowany do `.zip`. Import w Ustawienia → Pluginy, przegląd uprawnień, potem przełącznik włącz/wyłącz. Włączony działa od razu, bez restartu.
- `plugin.json` opisuje: identyfikator, wersję, plik wejściowy, uprawnienia, co plugin dodaje (sekcja w pasku bocznym, element paska statusu, komendy, własny typ zakładki) i **domyślną konfigurację**. Z konfiguracji powstaje formularz w Ustawieniach z „Przywróć domyślne”.
- Plugin może zrobić wszystko, na co pozwalają zadeklarowane uprawnienia (pliki, terminale, AI, sieć, procesy). Nie dostanie nigdy: haseł, kluczy API, magazynu poświadczeń, naciśnięć klawiszy w terminalu ani schowka w tle. Importer odrzuca archiwa, które o to proszą.
- Izolacja: każdy plugin w osobnym iframe (własny origin, CSP), wywołania przez host w Ruście ze sprawdzaniem uprawnień przy każdym wywołaniu. Awaria pluginu wyłącza tylko jego.
- Wbudowane pluginy (kod w `plugins/`, paczki w `release/plugins/`): **Notatki**, **Procesy w tle**, **Monitor zasobów**, **Porty**, **Pomodoro**.

### Plugin Procesy w tle (`bcgrnd_process`)

- Własna sekcja „PROCESY W TLE” w pasku bocznym z licznikiem.
- Zakładkę dodajesz, przeciągając ją z paska zakładek w dół na sekcję albo przez PPM → „Przenieś do Procesy w tle”. Plugin podpowiada też zakładki z wykrytym długim procesem (np. `npm run dev`, `docker compose up`); puste powłoki pomija.
- Zakładka znika z workspace'u, ale proces działa dalej. W sekcji widać workspace, czas działania i ostatnią linię wyjścia.
- Akcje: **Podgląd** (wyjście bez przywracania), **Przywróć** (na dawne miejsce w swoim workspace), **Zatrzymaj** (z 20-sekundowym cofnięciem).
- Wyłączenie pluginu oddaje wszystkie zakładki do ich workspace'ów.

### Plugin Notatki

- Sekcja „NOTATKI” w pasku bocznym, nad „Ustawieniami”, z ikonami **+** (nowa notatka) i **folderu** (nowy folder).
- Foldery w folderach. Przeciąganie: na środek folderu wkłada do środka, na górną lub dolną krawędź wiersza zmienia kolejność, na puste miejsce przenosi do katalogu głównego.
- Każda notatka to osobny plik `.md` w `plugins/tx.notes/data/notes/…`, foldery to katalogi. Tytuł jest opcjonalny (front matter); bez tytułu etykietą jest pierwsza linia treści.
- Przy każdej notatce przyciski **Edytuj** i **Usuń**, przy folderze: nowa notatka w środku, zmiana nazwy, usunięcie. Usuwanie z 20-sekundowym cofnięciem.

## 6. Funkcje Netcatty → nasza mapa

| Netcatty | U nas | Faza |
|---|---|---|
| Lokalny terminal | PowerShell, pwsh, CMD, WSL (autodetekcja dystrybucji) | 1 |
| Zakładki, splity, przywracanie sesji | + workspaces jako zakładki najwyższego poziomu | 1–2 |
| Motywy własne | Motywy tweakcn + paleta terminala z motywu | 0 |
| Podświetlanie słów kluczowych | Reguły regex → kolor (ERROR, WARN, IP, ścieżki) | 2 |
| Zapis bieżącego ekranu | PPM → „Zapisz ekran do pliku” | 2 |
| Obrazy inline (Sixel/Kitty/iTerm) | addon image xterm.js | 2 |
| Skróty archiwów (Ctrl+klik) | Dla sesji Linux/WSL przez OSC 7 | 2 |
| Catty Agent | Agent workspace'u + podagenci | 3 |
| Vault hostów (siatka/lista/drzewo), wyszukiwanie, grupy | Vault | 4 |
| SSH, Telnet, Mosh, Serial | SSH (russh), Telnet, Serial; Mosh później | 4 |
| Keychain / klucze | Keyring systemowy + generator kluczy SSH | 4 |
| Snippety | Snippety komend i promptów AI z wyborem modelu, zmienne | 3–4 |
| Port forwarding | Lokalny, zdalny, dynamiczny (SOCKS) | 4 |
| SFTP dwupanelowy + edytor | SFTP + lekki edytor (CodeMirror 6, lazy-load) | 4 |
| Ikony dystrybucji | Autodetekcja przez `/etc/os-release` | 4 |
| Monitoring (CPU, RAM, dysk, sieć, GPU, latencja) | Monitoring, kolumny konfigurowalne, odświeżanie ≥1 s | 6 |
| Integracja z Eksploratorem, flagi CLI | „Otwórz w TerminalX”, `--open-terminal-path`, `--open-terminal-shell` | 7 |
| Tryb portable | Folder `data` obok exe | 7 |
| — | **Workflow (nody)** | 5 |
| — | **Zdalny dostęp z telefonu (P2P)** | 7 |

---

## 7. Workflow

Canvas w zakładce (Svelte Flow), silnik DAG w Ruście.

**Interfejs**
- Lewa paleta nodów (zwijana do paska 40 px) z wyszukiwarką i kategoriami do zwijania. Klik w node dodaje go obok zaznaczonego i od razu łączy.
- Połączenia: przeciągnięcie z kropki po prawej stronie noda na inny node; klik w linię usuwa połączenie.
- Klik w node otwiera panel ustawień po prawej, a kanwa sama przewija się tak, żeby node nie chował się pod panelem.
- „Uruchom” wykonuje graf w kolejności topologicznej; node pokazuje stan (w trakcie / gotowe) i liczbę wyników.

**Wbudowane nody (39 w 8 kategoriach)**

| Kategoria | Nody |
|---|---|
| Wyzwalacze | Ręczny start, Harmonogram (cron), Push do git, Zmiana pliku, Webhook, Wyjście terminala (regex) |
| Terminal | Uruchom komendę, Wyślij do zakładki, Czekaj na wyjście, Snippet |
| AI | Prompt AI, Klasyfikacja, Ekstrakcja JSON, Podsumowanie, Tłumaczenie, Code review, Zadanie dla agenta |
| Logika | Warunek, Przełącznik, Pętla po liście, Równolegle, Opóźnienie, Scal |
| Dane | Szablon tekstu, JSON path, Regex, Zmienna, Podziel tekst, Złącz listę |
| Pliki | Czytaj plik, Zapisz plik, Lista plików |
| Sieć | Żądanie HTTP, Pobierz stronę |
| Wyjście | Podgląd, Powiadomienie, Zapisz w Notatkach, Kopiuj do schowka, Wyślij do agenta |

Pluginy będą mogły dodawać własne kategorie i nody (kontrybucja `nodes` w `plugin.json`, kolejna wersja API).

**Ustawienia noda AI**
- **Prompt bazowy** z biblioteki (opcjonalny), z podglądem treści.
- **Prompt dodatkowy**: doprecyzowanie, doklejane po bazowym.
- **Provider i model** (albo „Domyślny”).
- **Temperatura, maks. tokenów, top-p, liczba wyników** (1–10; przy więcej niż 1 node zwraca listę wariantów, a kolejny node może wybrać najlepszy).
- **Format wyniku**: tekst, JSON, lista.
- „Zapisz jako własny”: zamienia skonfigurowany node w nowy typ w palecie.

**Własne nody (Ustawienia → Nody)**: nazwa, kategoria, ikona, opis, prompt bazowy (opcjonalnie), prompt własny, provider i model, temperatura, tokeny, top-p, liczba wyników, format. To ustawienia domyślne każdego nowego wystąpienia; na kanwie można je nadpisać.

## 8. Zdalny dostęp z telefonu

**Cel:** sterowanie aplikacją z telefonu z dowolnego miejsca, bez publicznego IP, bez przekierowania portów, bez konta w chmurze i bez wystawiania czegokolwiek do internetu.

**Rozwiązanie: P2P po kluczu urządzenia (iroh)**

[iroh](https://iroh.computer) to biblioteka w Ruście (wersja 1.0) do połączeń QUIC adresowanych kluczem publicznym zamiast adresem IP. Przebija NAT (hole punching); gdy się nie uda, ruch idzie przez relay. Relay przekazuje tylko zaszyfrowane end-to-end pakiety. Pasuje do naszego rdzenia w Ruście bez dodatkowego procesu.

```
Telefon (aplikacja) --QUIC/TLS 1.3, E2E--+-- bezpośrednio (hole punching, większość sieci)
                                         +-- relay (fallback; widzi tylko szyfrogram)
                                                |
Komputer: rdzeń TerminalX -- Gateway -- ten sam protokół komend i zdarzeń co lokalne okno
```

**Tryby (Ustawienia → Zdalny dostęp)**
1. **Ta sama sieć Wi-Fi**: bezpośrednio w LAN (wykrywanie mDNS), nic nie wychodzi z domu.
2. **Z dowolnego miejsca (P2P)**: domyślny. Publiczny relay n0 jako fallback.
3. **Własny relay**: ten sam tryb przez Twój relay (`iroh-relay`, jeden plik na tanim VPS), jeśli nie chcesz polegać na publicznym.
4. **Tailscale**: jeśli już go masz, gateway nasłuchuje tylko na adresie z sieci tailnet.

**Parowanie i bezpieczeństwo**
- Na komputerze kod QR (NodeId komputera + jednorazowy sekret, ważny 5 min) i 6-cyfrowy kod zapasowy.
- Telefon generuje własną parę kluczy; komputer zapamiętuje jego klucz publiczny. Nowe urządzenie trzeba potwierdzić na komputerze.
- Uprawnienia per urządzenie: **podgląd**, **sterowanie**, **pełny** (z AI i ustawieniami). Odłączenie unieważnia klucz od razu.
- Komendy z listy „zawsze pytaj” wymagają zgody także zdalnie. Hasła, klucze API i Vault nigdy nie trafiają na telefon.
- Automatyczna blokada po bezczynności; historia połączeń w ustawieniach.

**Klient na telefonie**
- **Aplikacja mobilna z Tauri 2** (iOS i Android): ten sam kod Svelte, układ mobilny, natywny iroh, więc pełne P2P z hole punchingiem. Rozwiązanie docelowe.
- **Klient w przeglądarce (PWA)** jako szybki start bez instalacji: iroh w WASM działa w przeglądarce tylko przez relay (przeglądarka nie pozwala na surowe UDP), więc jest wolniej, ale też bez publicznego IP.
- Widoki: lista workspace'ów i zakładek, terminal z paskiem klawiszy (Esc, Ctrl, Tab, strzałki, paleta komend), czat z agentem i zatwierdzanie komend, Procesy w tle, powiadomienia (koniec procesu, prośba agenta o zgodę, błąd w workflow).
- Oszczędność transferu: wysyłane są różnice ekranu terminala (jak w mosh), a nie cały strumień; w tle tylko zdarzenia.

**Ograniczenia**
- Komputer musi być włączony, a aplikacja uruchomiona (może działać w zasobniku systemowym).
- Powiadomienia push przy zamkniętej aplikacji na telefonie wymagają usług Apple/Google; na start powiadomienia działają, gdy aplikacja jest otwarta lub w tle.
- Hole punching nie przechodzi przez część sieci firmowych i niektóre sieci komórkowe; wtedy działa relay, wolniej.
- Pierwszy krok fazy 7 to proof of concept: połączenie telefon ↔ komputer przez iroh w sieci komórkowej, pomiar opóźnienia przez relay i bezpośrednio.

## 9. Fazy

| Faza | Zakres | Efekt |
|---|---|---|
| **0. Fundament i design** | Scaffold Tauri+Svelte, design tokens, silnik motywów tweakcn, pasek tytułu, rail, zakładki, panel, status bar, paleta komend | Pusta, ale gotowa wizualnie aplikacja |
| **1. Terminale** | PTY (PS, pwsh, CMD, WSL), xterm.js WebGL, zakładki, splity, kopiuj/wklej, szukaj | Codzienne użycie jako terminal |
| **2. Workspaces i szlif** | Wiele workspace'ów, zapis i przywracanie, zamykanie z cofnięciem, skróty, podświetlanie, zapis ekranu, ustawienia | Zastępuje Windows Terminal |
| **2.5. Pluginy** | Host pluginów (iframe + uprawnienia), zwijane sekcje, menu PPM zakładki, import .zip, konfiguracja; wbudowane: Notatki, Procesy w tle, Monitor zasobów, Porty, Pomodoro | Notatki i procesy w tle w pasku bocznym |
| **3. AI** | Providerzy i domyślny model, biblioteka promptów, profile agentów i podagentów, przypisania, uprawnienia, panel czatu, snippety AI | |
| **4. SSH** | Vault, SSH, keyring, snippety komend, port forwarding, SFTP | Parytet z Netcatty |
| **5. Workflow** | Canvas, 39 nodów w 8 kategoriach, panel ustawień noda, własne nody, silnik DAG | |
| **6. Monitoring** | Metryki hostów | |
| **7. Zdalny dostęp** | PoC iroh, gateway (iroh + LAN), parowanie QR, uprawnienia urządzeń, klient PWA, potem aplikacja mobilna Tauri 2 | Sterowanie z telefonu |
| **8. Dystrybucja** | Auto-update, portable, Eksplorator, buildy Linux/macOS | |

## 10. Łatwa zmiana nazwy i marki

Nazwa „TerminalX” jest robocza. Wszystko, co zależy od marki, czyta z jednego miejsca:
- `brand.json` w katalogu głównym: nazwa, identyfikator (`com.example.terminalx`), opis, kolor, ścieżka do ikon.
- Skrypt `scripts/apply-brand` generuje z niego `tauri.conf.json` (productName, identifier), `package.json`, nazwę instalatora i wpis „Otwórz w …” w Eksploratorze.
- UI czyta nazwę z `src/lib/brand.ts` (generowany), w kodzie nigdzie nie wpisujemy jej na sztywno.
- Katalog danych użytkownika liczony z identyfikatora, więc zmiana nazwy przed wydaniem 1.0 niczego nie psuje.

## 11. Struktura repo (docelowo)

```
terminalx/
  src-tauri/          # Rust: core, pty, agents, workflow, gateway
    src/{pty,session,workspace,theme,agent,workflow,gateway}/
  src/                # Svelte UI
    lib/components/   # shadcn-svelte
    lib/features/{workspace,terminal,agent,workflow,settings}/
    lib/theme/        # parser tweakcn → CSS vars + paleta ANSI
  themes/             # wbudowane motywy (JSON tweakcn)
  plugins/            # wbudowane pluginy (źródła) + sdk/ z typami API
  docs/PLUGINS.md     # specyfikacja pluginów
  scripts/            # pack-plugins.ps1, apply-brand
  release/plugins/       # spakowane .zip
```
