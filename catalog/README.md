# Katalog modeli lokalnych

Aplikacja raz na dobę pobiera `models.json` z gałęzi `main` tego repozytorium. Wpisy dodają nowe modele
albo zastępują wbudowane o tym samym `id` (`src/lib/workflow/presets.ts`), więc nowy model nie wymaga
wydania nowej wersji aplikacji.

```json
{
  "version": 1,
  "presets": [
    {
      "id": "moj_model",
      "name": "Mój model",
      "desc": "Krótki opis widoczny w Ustawienia → Lokalne AI.",
      "ops": ["image"],
      "vram": 8, "ram": 16,
      "area": 1048576, "mult": 16,
      "files": [
        { "dir": "checkpoints", "name": "model.safetensors", "url": "https://huggingface.co/…/resolve/main/model.safetensors", "size": 6938078334, "sha256": "…" }
      ],
      "graphs": {
        "image": { "1": { "class_type": "KSampler", "inputs": { "seed": "{{seed}}", "steps": "{{x.steps|20}}" } } }
      }
    }
  ]
}
```

- `ops`: `image`, `edit`, `video`, `i2v`, `upscale`, `rmbg`. Dla każdej operacji potrzebny jest graf w `graphs`.
- `graphs`: workflow ComfyUI w formacie API (Workflow → Export (API)). W miejscu wartości można wpisać:
  `{{prompt}}`, `{{negative|domyślny tekst}}`, `{{image}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{frames}}`, `{{fps}}`
  i `{{x.nazwa|domyślna}}` (parametr z pola „Parametry” noda). Pole z samym znacznikiem dostaje liczbę albo tekst,
  znacznik wewnątrz tekstu jest wstawiany jako tekst.
- `files`: tylko adresy `https://huggingface.co/` i GitHuba; `dir` i `name` bez ukośników i `..`.
  `sha256` jest opcjonalne (dla Hugging Face aplikacja pobiera sumę sama).
- `vram`, `ram`: zalecana pamięć w GB (kolor kropki dopasowania); `area`: liczba pikseli kadru; `mult`: wielokrotność wymiarów.
  Wideo: `fps`, `step` (klatki = step·k + 1), `dur` (domyślna długość w s).

Przed wysłaniem zmian uruchom `npm test`: testy sprawdzają, że katalog przechodzi walidację.
