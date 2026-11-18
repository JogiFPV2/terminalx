# Hermitty na Androida

Etap 1: pilot do Hermitty na komputerze. Terminale (PowerShell, CMD, WSL, SSH), czat z agentem ze zgodami
na komendy, workflow i procesy w tle działają na komputerze, a telefon je pokazuje i nimi steruje.
Osobna aplikacja (`app.hermitty.mobile`), obok aplikacji-mostka „Hermitty Telefon”.

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
