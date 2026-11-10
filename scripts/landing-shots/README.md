# Zrzuty aplikacji do landing page

Zrzuty w `landing/img/app/` pochodzą z prawdziwego interfejsu Hermitty (kod z `src/`) uruchomionego w przeglądarce.
Rdzeń w Ruście zastępuje atrapa (`stub.js`), a `seed.js` dostarcza przykładowe dane: wyjście terminali,
hosty SSH, notatki, klucze, rozmowę z agentem i workflow. Motyw: Pinsy, jasny i ciemny.

```powershell
npm run dev                                   # Vite na porcie 1420
node scripts/landing-shots/scenes.cjs out "" light,dark   # PNG 2x do folderu out
# opcjonalnie tylko wybrane sceny: node scripts/landing-shots/scenes.cjs out term-ps,ai-agent light
```

Potem PNG zamieniamy na WebP (szerokość 1600 px) i kopiujemy do `landing/img/app/<scena>-<light|dark>.webp`,
np. `cwebp -q 80 -resize 1600 0 out/term-ps-light.png -o landing/img/app/term-ps-light.webp`.
Wymaga Playwrighta z Chromium.
