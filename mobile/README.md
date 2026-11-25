# Hermitty na Androida

Etap 1: pilot do Hermitty na komputerze. Terminale (PowerShell, CMD, WSL, SSH), czat z agentem ze zgodami
na komendy, workflow i procesy w tle działają na komputerze, a telefon je pokazuje i nimi steruje.
Osobna aplikacja (`app.hermitty.mobile`), obok aplikacji-mostka „Hermitty Telefon”.

Etap 2 (w toku): sekrety w Android Keystore. Klucze sparowanych komputerów (a potem klucz API AI i hasła SSH)
szyfruje klucz AES-GCM, którego nie da się wyjąć z telefonu (`gen/android/.../KeystorePlugin.kt`, `src-tauri/src/secret.rs`,
`src/lib/secrets.ts`). Starsze wpisy z kluczem w localStorage przenoszą się same przy pierwszym uruchomieniu.

SSH z telefonu (sekcja „Ten telefon”): serwery z hasłem albo kluczem (generowany ed25519 lub wklejony OpenSSH/PuTTY),
potwierdzanie klucza serwera przy pierwszym połączeniu, terminal dopasowany do ekranu. Rdzeń: `src-tauri/src/ssh.rs`.
Test bez telefonu (wersja debug na komputerze, potrzebny serwer SSH):

Agent AI na telefonie: Anthropic, OpenAI, OpenRouter, Google, Ollama albo serwer zgodny z OpenAI; klucz w sejfie,
zapytania z Rusta (`src-tauri/src/ai.rs`). Narzędzia: `list_servers` i `run_command` (każda komenda za zgodą).

```sh
HERMITTY_AI_SELFTEST=http://127.0.0.1:7799 HERMITTY_SSH_SELFTEST='127.0.0.1:2222:uzytkownik:haslo' xvfb-run -a mobile/src-tauri/target/debug/hermitty-mobile
```

Etap 3: mostek z komputerem wbudowany (dawna aplikacja „Hermitty Telefon”, `app.hermitty.phone`): powiadomienia,
SMS-y, zdalny dyktafon i dzwonek w Hermitty na komputerze przez wtyczkę Telefon. Kod Kotlina z `android/` jest
w `gen/android/.../bridge`, a ekran w `src/components/Bridge.svelte` (wtyczka `BridgePlugin.kt`).
Skaner rozpoznaje kod wtyczki Telefon (`hermitty://pair…`), a link otwiera aplikację od razu na ekranie mostka.
Jeśli na telefonie jest też stara aplikacja „Hermitty Telefon”, odinstaluj ją, żeby komputer nie widział dwóch telefonów.

Workspace'y (ekran startowy → Ten telefon → Workspace'y): workspace'y telefonu z zakładkami Termux, SSH, notatki,
agent AI (z narzędziami na zakładkach workspace'u), pliki (SFTP), workflow i terminale z komputera. Gdy telefon jest
sparowany z komputerem, obok pojawiają się workspace'y komputera z zakładkami (obramowanie w ich kolorze i ikona monitora).

Termux: Hermitty używa API Termuxa dla innych aplikacji (RUN_COMMAND, `TermuxPlugin.kt`), żeby raz zainstalować
openssh, dodać swój klucz i uruchomić sshd; zakładka Termuxa to potem sesja SSH na 127.0.0.1:8022 (pełny terminal).
Wymaga w Termuxie `allow-external-apps=true` (aplikacja pokazuje komendę do wklejenia) i zgody Androida na RUN_COMMAND.

Workflow: ten sam format i te same nody co na komputerze (`src/lib/defaults.ts`, wspólna logika `src/lib/workflow/logic.ts`);
„Uruchom komendę” idzie do Termuxa albo serwera SSH, nody AI używają modelu agenta. Grafika, wideo i pliki komputera
są oznaczone jako „tylko na komputerze”. Eksport/import JSON między telefonem a komputerem.

## Jak połączyć

1. Na komputerze: Hermitty → Ustawienia → **Zdalny dostęp** → włącz → **Sparuj telefon**.
2. W aplikacji: **Dodaj komputer** → zeskanuj kod QR (albo wklej link spod kodu).
3. Na komputerze zatwierdź nowe urządzenie. Uprawnienie (podgląd / sterowanie / pełny dostęp) zmienisz tam w każdej chwili.

Telefon i komputer muszą być w tej samej sieci albo w Tailscale. Protokół i szyfrowanie: `src-tauri/src/remote.rs`,
`src-tauri/src/remote_crypto.rs`, klient: `mobile/src/lib/link.ts`, wspólna kryptografia: `src/lib/remote-crypto.ts`.

## Rozwój

```bash
npm run mobile:fake    # atrapa Hermitty na komputerze (port 7420) z linkiem do parowania
npm run mobile:dev     # interfejs w przeglądarce: http://localhost:1421
npm run mobile:check   # typy
npm test               # m.in. tests/mobile-link.test.ts (parowanie, zapytania, uprawnienia)
```

## APK

Wymaga JDK 17+, Android SDK i NDK (`ANDROID_HOME`, `NDK_HOME`) oraz celów Rusta `aarch64-linux-android` itd.

```bash
cd mobile
npx tauri android build --apk --target aarch64     # release (ok. 7 MB), niepodpisany
# podpis do instalacji ręcznej, np. kluczem debug:
zipalign -f -p 4 src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk aligned.apk
apksigner sign --ks ~/.android/debug.keystore --ks-pass pass:android --ks-key-alias androiddebugkey --out Hermitty-Android.apk aligned.apk
```

`--debug` daje APK od razu podpisany kluczem debug, ale ok. 140 MB (biblioteka Rusta z symbolami).
Wersję do wydania podpisuje się własnym kluczem (keystore) według dokumentacji Tauri. Aplikacja podpisana innym
kluczem nie zainstaluje się „na” wersję testową: trzeba ją najpierw odinstalować.
