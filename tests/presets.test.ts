// Przepisy modeli lokalnych: każdy graf musi pasować do definicji nodów ComfyUI (wejścia odczytane z kodu
// ComfyUI 0.43, plik comfy-schema.json: node → {wejście: 1 gdy opcjonalne}). Uruchomienie: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, params, inspectCustom, customPreset, fillTemplate, validEntry, mergeCatalog, type Graph } from '../src/lib/workflow/presets.ts';

const schema: Record<string, Record<string, 0 | 1>> = JSON.parse(readFileSync(new URL('./comfy-schema.json', import.meta.url), 'utf8'));
const cfg = { base: '', prompt: '', provider: '', model: '', aspect: '16:9', duration: '2', negative: '', seed: '', n: 1, params: '' } as any;

function validate(g: Graph) {
  const errs: string[] = [];
  for (const [id, n] of Object.entries(g)) {
    const s = schema[n.class_type];
    if (!s) { errs.push(`${id}: nieznany node ${n.class_type}`); continue; }
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!(k in s) && !(k.includes('.') && k.split('.')[0] in s)) errs.push(`${id} ${n.class_type}: nieznane wejście ${k}`);
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && !g[v[0]]) errs.push(`${id}: link do brakującego noda ${v[0]}`);
    }
    for (const [k, opt] of Object.entries(s)) if (!opt && !(k in n.inputs)) errs.push(`${id} ${n.class_type}: brak wymaganego ${k}`);
  }
  return errs;
}

for (const pr of PRESETS) for (const op of pr.ops) {
  test(`${pr.id} (${op}) – graf zgodny z ComfyUI`, () => {
    const g = pr.build(op, params(pr, op, cfg, 'kot na dachu', op === 'image' || op === 'video' ? '' : 'in.png'));
    assert.deepEqual(validate(g), []);
    // Każdy plik modelu z listy jest użyty w grafie (inaczej pobieralibyśmy zbędne gigabajty).
    const text = JSON.stringify(g);
    for (const f of pr.files) assert.ok(text.includes(f.name), `${f.name} nieużyty`);
  });
}

test('parametry: proporcje, klatki, seed', () => {
  const ltx = PRESETS.find((p) => p.id === 'ltxv')!;
  const p = params(ltx, 'video', { ...cfg, seed: '7' }, 'x', '');
  assert.equal(p.width % 32, 0);
  assert.equal(p.height % 32, 0);
  assert.ok(p.width > p.height);
  assert.equal(p.frames, 49); // 2 s · 24 kl./s, wielokrotność 8 + 1
  assert.equal(p.seed, 7);
  assert.throws(() => params(ltx, 'rmbg', cfg, 'x', ''));
  assert.throws(() => params(ltx, 'video', { ...cfg, params: '{zły json' }, 'x', ''));
});

test('szablony katalogu: typy wartości i domyślne', () => {
  const g = fillTemplate({ '1': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{x.steps|8}}', text: 'styl: {{prompt}}', neg: '{{negative|brzydkie}}' } } }, { prompt: 'kot', negative: '', seed: 5, width: 1, height: 1, frames: 1, fps: 1, image: '', x: {} });
  assert.deepEqual(g['1'].inputs, { seed: 5, steps: 8, text: 'styl: kot', neg: 'brzydkie' });
});

test('katalog: odrzuca niebezpieczne wpisy', () => {
  const ok = { id: 'nowy', name: 'Nowy', desc: '', ops: ['image'], vram: 8, ram: 16, area: 1048576, mult: 16, files: [{ dir: 'checkpoints', name: 'a.safetensors', url: 'https://huggingface.co/x/y/resolve/main/a.safetensors', size: 10 }], graphs: { image: { '1': { class_type: 'SaveImage', inputs: {} } } } };
  assert.ok(validEntry(ok));
  assert.ok(!validEntry({ ...ok, files: [{ ...ok.files[0], name: '../../evil.exe' }] }));
  assert.ok(!validEntry({ ...ok, files: [{ ...ok.files[0], dir: '..' }] }));
  assert.ok(!validEntry({ ...ok, files: [{ ...ok.files[0], url: 'https://evil.example/a' }] }));
  assert.ok(!validEntry({ ...ok, ops: ['video'] }));
  const merged = mergeCatalog(PRESETS, { version: 1, presets: [ok, { ...ok, id: 'zimage' }] as any });
  assert.equal(merged.filter((p) => p.id === 'zimage').length, 1);
  assert.ok(merged.some((p) => p.id === 'nowy'));
});

test('własne workflow: format API, podstawienia', () => {
  assert.throws(() => inspectCustom({ nodes: [] }), /Export \(API\)/);
  const graph = {
    '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' } },
    '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  };
  const pr = customPreset({ id: 'c1', name: 'Mój', op: 'image', graph, created: 0 });
  const g = pr.build('image', { ...params(pr, 'image', { ...cfg, seed: '42' }, 'pies', ''), negative: 'zły' });
  assert.equal(g['6'].inputs.text, 'pies');
  assert.equal(g['7'].inputs.text, 'zły');
  assert.equal(g['3'].inputs.seed, 42);
  assert.ok((g['5'].inputs.width as number) > (g['5'].inputs.height as number));
});

test('catalog/models.json z repozytorium przechodzi walidację', () => {
  const cat = JSON.parse(readFileSync(new URL('../catalog/models.json', import.meta.url), 'utf8'));
  assert.equal(cat.version, 1);
  for (const e of cat.presets) {
    assert.ok(validEntry(e), `wpis ${e.id} niepoprawny`);
    for (const op of e.ops) assert.deepEqual(validate(fillTemplate(e.graphs[op], { prompt: 'x', negative: '', seed: 1, width: 512, height: 512, frames: 17, fps: 16, image: 'a.png', x: {} })), [], e.id);
  }
});
