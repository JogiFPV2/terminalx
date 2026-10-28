# Pakuje każdy folder z plugins/ (poza sdk) do release/plugins/<id>-<wersja>.zip.
# plugin.json ląduje w katalogu głównym archiwum, tak jak oczekuje importer w Ustawieniach.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'release\plugins'
New-Item -ItemType Directory -Force $out | Out-Null

Get-ChildItem (Join-Path $root 'plugins') -Directory | Where-Object { $_.Name -ne 'sdk' } | ForEach-Object {
    $manifestPath = Join-Path $_.FullName 'plugin.json'
    if (-not (Test-Path $manifestPath)) { Write-Warning "Pomijam $($_.Name): brak plugin.json"; return }
    $m = Get-Content $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($field in 'id', 'name', 'version', 'main') {
        if (-not $m.$field) { throw "$($_.Name)/plugin.json: brak pola '$field'" }
    }
    if (-not (Test-Path (Join-Path $_.FullName $m.main))) { throw "$($_.Name): brak pliku $($m.main)" }

    $zip = Join-Path $out "$($m.id)-$($m.version).zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path (Join-Path $_.FullName '*') -DestinationPath $zip
    Write-Host "OK  $zip"
}
