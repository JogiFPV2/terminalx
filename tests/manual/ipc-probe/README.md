# Test ręczny: dostęp ramki pluginu do rdzenia

Pluginy działają w ramce `sandbox="allow-scripts"` z CSP bez sieci, a każde wywołanie przechodzi przez host,
który sprawdza uprawnienia z `plugin.json`. Ten test sprawdza w prawdziwej aplikacji na Windows (WebView2),
czy kod w ramce może zawołać rdzeń bezpośrednio, z pominięciem hosta. Tego nie da się sprawdzić w przeglądarce
ani na Linuksie, bo zależy od tego, co Tauri wstrzykuje do ramek w WebView2.

1. Spakuj ten folder: w PowerShell z katalogu repozytorium
   `Compress-Archive tests/manual/ipc-probe/* ipc-probe.zip -Force`
2. Hermitty → Ustawienia → Pluginy → Importuj → `ipc-probe.zip`, potem włącz „Test IPC”.
3. W pasku bocznym pojawi się sekcja „Test IPC”:
   - **OK** (wszystkie ✓): ramka nie ma dostępu do rdzenia, izolacja działa.
   - **PROBLEM** (któryś ✗): plugin może wołać komendy rdzenia bez uprawnień. Zgłoś wynik; poprawka wymaga
     zablokowania IPC dla ramek w `src-tauri/src/lib.rs`.
4. Po teście odinstaluj plugin.
