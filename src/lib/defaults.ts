import type { AgentProfile, AppState, MediaOp, NodeTypeDef, PromptItem, Provider, Snippet } from './types';

/** Nazwa, wersja i repozytorium aplikacji (repo: katalog modeli online, aktualizacje). */
export const BRAND = { name: 'TerminalX', version: __APP_VERSION__, repo: 'JogiFPV2/terminalx' };

type ProviderTypeDef = { label: string; url: string; models: string[]; chat?: boolean; media?: Partial<Record<MediaOp, string[]>> };

// `models` to modele czatu; `media` podpowiada modele dla nodów grafiki i wideo (wolny tekst, każdy model providera zadziała).
export const PROVIDER_TYPES: Record<Provider['type'], ProviderTypeDef> = {
  anthropic: { label: 'Anthropic', url: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', models: [],
    media: { image: ['gpt-image-1'], edit: ['gpt-image-1'], video: ['sora-2', 'sora-2-pro'], i2v: ['sora-2', 'sora-2-pro'] } },
  google: { label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    media: { image: ['gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001'], edit: ['gemini-2.5-flash-image'],
      video: ['veo-3.0-generate-001', 'veo-3.0-fast-generate-001'], i2v: ['veo-3.0-generate-001', 'veo-3.0-fast-generate-001'] } },
  fal: { label: 'fal.ai (grafika i wideo)', url: 'https://queue.fal.run', models: [], chat: false,
    media: {
      image: ['fal-ai/flux/schnell', 'fal-ai/flux/dev', 'fal-ai/flux-pro/v1.1-ultra', 'fal-ai/imagen4/preview', 'fal-ai/nano-banana', 'fal-ai/recraft/v3/text-to-image', 'fal-ai/ideogram/v3'],
      edit: ['fal-ai/nano-banana/edit', 'fal-ai/flux-pro/kontext', 'fal-ai/bytedance/seedream/v4/edit'],
      video: ['fal-ai/veo3', 'fal-ai/kling-video/v2.1/master/text-to-video', 'fal-ai/minimax/hailuo-02/standard/text-to-video', 'fal-ai/bytedance/seedance/v1/pro/text-to-video'],
      i2v: ['fal-ai/kling-video/v2.1/standard/image-to-video', 'fal-ai/veo3/image-to-video', 'fal-ai/minimax/hailuo-02/standard/image-to-video', 'fal-ai/bytedance/seedance/v1/pro/image-to-video'],
      upscale: ['fal-ai/clarity-upscaler', 'fal-ai/esrgan'],
      rmbg: ['fal-ai/birefnet'],
    } },
  replicate: { label: 'Replicate (grafika i wideo)', url: 'https://api.replicate.com/v1', models: [], chat: false,
    media: {
      image: ['black-forest-labs/flux-schnell', 'black-forest-labs/flux-1.1-pro', 'google/imagen-4', 'ideogram-ai/ideogram-v3-turbo', 'recraft-ai/recraft-v3'],
      edit: ['black-forest-labs/flux-kontext-pro', 'google/nano-banana'],
      video: ['google/veo-3', 'kwaivgi/kling-v2.1', 'minimax/hailuo-02', 'bytedance/seedance-1-pro'],
      i2v: ['kwaivgi/kling-v2.1', 'minimax/hailuo-02', 'bytedance/seedance-1-pro'],
      upscale: ['nightmareai/real-esrgan'],
      rmbg: ['851-labs/background-remover'],
    } },
  // Modele lokalne to przepisy z workflow/comfy.svelte.ts (wbudowane i zaimportowane), nie lista stała.
  comfy: { label: 'ComfyUI (lokalnie)', url: 'http://127.0.0.1:8188', models: [], chat: false, media: { image: [], edit: [], video: [], i2v: [], upscale: [], rmbg: [] } },
  compat: { label: 'Zgodny z OpenAI', url: 'http://localhost:1234/v1', models: [] },
  ollama: { label: 'Ollama (lokalnie)', url: 'http://localhost:11434', models: [] },
};

/** Providerzy, którzy umieją czat (agenci, snippety, nody AI). */
export const isChat = (p: Provider) => PROVIDER_TYPES[p.type]?.chat !== false;
/** Providerzy grafiki i wideo. */
export const isMedia = (p: Provider) => !!PROVIDER_TYPES[p.type]?.media;

export const DEFAULT_PROVIDERS: Provider[] = [
  { id: 'anthropic', type: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com', keyRef: 'provider:anthropic', hasKey: false, models: [...PROVIDER_TYPES.anthropic.models] },
  { id: 'ollama', type: 'ollama', name: 'Ollama', url: 'http://localhost:11434', keyRef: 'provider:ollama', hasKey: false, models: [] },
];

export const TOOLS = {
  agent: { delegate: 'Delegowanie do podagentów', read_all: 'Odczyt wszystkich zakładek', run_command: 'Uruchamianie komend', workflow: 'Uruchamianie workflow' },
  sub: { read_buffer: 'Odczyt bufora terminala', run_command: 'Uruchamianie komend', wait_for_output: 'Czekanie na wyjście', report: 'Raport do agenta' },
} as const;

export const PERM_LABEL = { read: 'Tylko odczyt', ask: 'Pytaj przed komendą', auto: 'Automatycznie' } as const;

export const DEFAULT_AGENTS: AgentProfile[] = [
  { id: 'boss', kind: 'agent', name: 'Szef (domyślny)', provider: 'anthropic', model: 'claude-opus-5-5', perm: 'ask', parallel: 3,
    tools: ['delegate', 'read_all', 'run_command', 'workflow'],
    prompt: 'Jesteś agentem workspace\'u w aplikacji terminalowej. Rozbijasz zadania na kroki, delegujesz pracę w konkretnych terminalach podagentom zakładek, sprawdzasz ich wyniki i krótko raportujesz użytkownikowi po polsku.' },
  { id: 'devops', kind: 'agent', name: 'DevOps', provider: 'anthropic', model: 'claude-sonnet-5-5', perm: 'ask', parallel: 4,
    tools: ['delegate', 'read_all', 'run_command'],
    prompt: 'Specjalizujesz się w Dockerze, sieciach i wdrożeniach. Zanim cokolwiek zmienisz, sprawdzasz stan. Odpowiadasz zwięźle po polsku.' },
  { id: 'sub', kind: 'sub', name: 'Podagent terminala', provider: 'anthropic', model: 'claude-sonnet-5-5', perm: 'ask',
    tools: ['read_buffer', 'run_command', 'wait_for_output', 'report'],
    prompt: 'Pracujesz w jednym terminalu. Wykonujesz zadanie od agenta, sprawdzasz wynik w wyjściu terminala i kończysz zwięzłym raportem.' },
  { id: 'watch', kind: 'sub', name: 'Obserwator (tylko odczyt)', provider: 'anthropic', model: 'claude-haiku-5-5', perm: 'read',
    tools: ['read_buffer', 'report'],
    prompt: 'Obserwujesz wyjście terminala i zgłaszasz błędy agentowi. Nie uruchamiasz komend.' },
];

export const DEFAULT_SNIPPETS: Snippet[] = [
  { id: 's1', name: 'Wyjaśnij ostatni błąd', kind: 'ai', body: 'Wyjaśnij ostatni błąd z terminala i zaproponuj poprawkę.\n\n{{last_output:80}}', provider: null, model: null },
  { id: 's2', name: 'Commit message', kind: 'ai', body: 'Napisz zwięzły commit message (Conventional Commits) dla zmian:\n\n{{cmd:git diff --staged}}', provider: 'anthropic', model: 'claude-haiku-5-5' },
  { id: 's3', name: 'Porty w użyciu', kind: 'cmd', body: 'Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Select-Object LocalPort, OwningProcess', provider: null, model: null },
  { id: 's4', name: 'Restart kontenera', kind: 'cmd', body: 'docker compose restart {{usługa}}', provider: null, model: null },
];

export const DEFAULT_PROMPTS: PromptItem[] = [
  { id: 'pf-code', type: 'folder', parent: null, name: 'Kod', open: true },
  { id: 'p-review', type: 'prompt', parent: 'pf-code', name: 'Code review', body: 'Zrób przegląd kodu poniżej. Wypisz błędy, ryzyka i proste poprawki, od najważniejszych. Nie zmieniaj stylu bez powodu.\n\n{{input}}' },
  { id: 'p-explain', type: 'prompt', parent: 'pf-code', name: 'Wyjaśnij błąd', body: 'Wyjaśnij, co oznacza ten błąd i jaka jest najbardziej prawdopodobna przyczyna. Zaproponuj poprawkę.\n\n{{input}}' },
  { id: 'p-refactor', type: 'prompt', parent: 'pf-code', name: 'Refaktoryzacja', body: 'Zaproponuj refaktoryzację, która upraszcza kod bez zmiany zachowania. Pokaż diff.\n\n{{input}}' },
  { id: 'pf-devops', type: 'folder', parent: null, name: 'DevOps', open: true },
  { id: 'p-logs', type: 'prompt', parent: 'pf-devops', name: 'Analiza logów', body: 'Przeanalizuj logi. Pogrupuj błędy, policz wystąpienia i wskaż pierwszy błąd, który mógł wywołać resztę.\n\n{{input}}' },
  { id: 'pf-docker', type: 'folder', parent: 'pf-devops', name: 'Docker', open: false },
  { id: 'p-dockerfile', type: 'prompt', parent: 'pf-docker', name: 'Przegląd Dockerfile', body: 'Sprawdź Dockerfile pod kątem rozmiaru obrazu, cache warstw i bezpieczeństwa.\n\n{{input}}' },
  { id: 'pf-text', type: 'folder', parent: null, name: 'Tekst', open: false },
  { id: 'p-summary', type: 'prompt', parent: 'pf-text', name: 'Podsumowanie', body: 'Podsumuj w 3–5 punktach. Konkretnie, bez wstępu.\n\n{{input}}' },
  { id: 'p-commit', type: 'prompt', parent: 'pf-text', name: 'Commit message', body: 'Napisz commit message w stylu Conventional Commits.\n\n{{input}}' },
  { id: 'p-plen', type: 'prompt', parent: 'pf-text', name: 'PL → EN techniczny', body: 'Przetłumacz na techniczny angielski. Zachowaj nazwy kodu bez zmian.\n\n{{input}}' },
  { id: 'p-classify', type: 'prompt', parent: 'pf-text', name: 'Klasyfikacja zgłoszenia', body: 'Przypisz tekst do jednej z kategorii: błąd, pytanie, prośba o funkcję, inne. Odpowiedz tylko nazwą kategorii.\n\n{{input}}' },
];

export const NODE_CATS = ['Wyzwalacze', 'Terminal', 'AI', 'Grafika', 'Wideo', 'Logika', 'Dane', 'Pliki', 'Sieć', 'Wyjście', 'Własne'];
export const CAT_COLOR: Record<string, string> = {
  Wyzwalacze: 'var(--chart-3)', Terminal: 'var(--chart-2)', AI: 'var(--primary)', Grafika: 'var(--chart-5)', Wideo: 'var(--chart-4)', Logika: 'var(--chart-1)', Dane: 'var(--chart-5)',
  Pliki: 'var(--muted-foreground)', 'Sieć': 'var(--chart-4)', 'Wyjście': 'var(--chart-1)', 'Własne': 'var(--chart-4)',
};
const NT = (id: string, cat: string, name: string, icon: string, extra: Partial<NodeTypeDef> = {}): NodeTypeDef => ({ id, cat, name, icon, ...extra });

export const BUILTIN_NODES: NodeTypeDef[] = [
  NT('manual', 'Wyzwalacze', 'Ręczny start', 'play', { desc: 'Start po kliknięciu „Uruchom”.' }),
  NT('cron', 'Wyzwalacze', 'Harmonogram', 'clock', { desc: 'Uruchamia workflow co określony czas, gdy aplikacja działa.', fields: [['every', 'Co ile minut', '60']] }),
  NT('git_push', 'Wyzwalacze', 'Push do git', 'branch', { desc: 'Sprawdza nowe commity w katalogu repozytorium.', fields: [['repo', 'Katalog repozytorium', ''], ['branch', 'Gałąź', 'main']] }),
  NT('file_watch', 'Wyzwalacze', 'Zmiana pliku', 'file', { desc: 'Przekazuje dalej treść pliku.', fields: [['path', 'Ścieżka pliku', '']] }),
  NT('webhook', 'Wyzwalacze', 'Webhook', 'globe', { desc: 'Pobiera dane z adresu URL na starcie.', fields: [['url', 'Adres', '']] }),
  NT('term_match', 'Wyzwalacze', 'Wyjście terminala', 'term', { desc: 'Czeka, aż w zakładce pojawi się tekst pasujący do wzorca.', fields: [['regex', 'Regex', 'ERROR|FAIL'], ['tab', 'Zakładka (nazwa)', ''], ['timeout', 'Limit (s)', '120']] }),
  NT('run_cmd', 'Terminal', 'Uruchom komendę', 'term', { desc: 'Uruchamia skrypt w tle i zwraca jego wyjście.', fields: [['command', 'Komenda', 'echo {{input}}'], ['shell', 'Powłoka (pwsh, cmd, powershell, wsl)', 'pwsh'], ['cwd', 'Katalog', '']] }),
  NT('send_tab', 'Terminal', 'Wyślij do zakładki', 'out', { desc: 'Wpisuje tekst do otwartej zakładki terminala.', fields: [['tab', 'Zakładka (nazwa)', ''], ['text', 'Tekst', '{{input}}']] }),
  NT('wait_out', 'Terminal', 'Czekaj na wyjście', 'timer', { fields: [['tab', 'Zakładka (nazwa)', ''], ['regex', 'Regex', 'ready'], ['timeout', 'Limit (s)', '60']] }),
  NT('snippet', 'Terminal', 'Snippet', 'snip', { fields: [['snippet', 'Nazwa snippetu', ''], ['tab', 'Zakładka (nazwa)', '']] }),
  NT('ai_prompt', 'AI', 'Prompt AI', 'spark', { ai: true }),
  NT('ai_classify', 'AI', 'Klasyfikacja', 'filter', { ai: true, base: 'p-classify' }),
  NT('ai_extract', 'AI', 'Ekstrakcja JSON', 'braces', { ai: true, format: 'json' }),
  NT('ai_summary', 'AI', 'Podsumowanie', 'list', { ai: true, base: 'p-summary' }),
  NT('ai_translate', 'AI', 'Tłumaczenie', 'globe', { ai: true, base: 'p-plen' }),
  NT('ai_review', 'AI', 'Code review', 'shield', { ai: true, base: 'p-review' }),
  NT('ai_agent', 'AI', 'Zadanie dla agenta', 'bot', { desc: 'Wysyła zadanie do agenta workspace\'u i czeka na odpowiedź.', fields: [['task', 'Zadanie', '{{input}}']] }),
  NT('ai_vision', 'AI', 'Opisz obraz', 'eye', { ai: true, desc: 'Model z obsługą obrazów opisuje grafikę z poprzedniego noda. Każdy node AI widzi obrazy z wejścia.',
    defaults: { prompt: 'Opisz szczegółowo ten obraz: kompozycję, styl, światło i kolory. Opis ma się nadawać na prompt do generatora obrazów.' } }),
  NT('img_gen', 'Grafika', 'Generuj obraz', 'image', { media: 'image', desc: 'Tekst → obraz. Prompt z biblioteki, prompt noda i {{input}} z poprzedniego noda.' }),
  NT('img_edit', 'Grafika', 'Edytuj obraz', 'wand', { media: 'edit', desc: 'Obraz z wejścia + polecenie → nowy obraz (zmiana stylu, tła, obiektów).' }),
  NT('img_upscale', 'Grafika', 'Powiększ', 'maximize', { media: 'upscale', desc: 'Zwiększa rozdzielczość obrazu z wejścia.' }),
  NT('img_rmbg', 'Grafika', 'Usuń tło', 'scissors', { media: 'rmbg', desc: 'Wycina obiekt z obrazu (PNG z przezroczystością).' }),
  NT('media_in', 'Grafika', 'Plik z dysku', 'upload', { desc: 'Obraz albo wideo z dysku jako wejście dla kolejnych nodów.', fields: [['path', 'Plik', '']] }),
  NT('vid_gen', 'Wideo', 'Generuj wideo', 'film', { media: 'video', desc: 'Tekst → klip wideo.' }),
  NT('vid_i2v', 'Wideo', 'Obraz → wideo', 'clapper', { media: 'i2v', desc: 'Animuje obraz z wejścia według promptu.' }),
  NT('vid_frame', 'Wideo', 'Ostatnia klatka', 'image', { desc: 'Wyciąga ostatnią klatkę klipu (do łączenia scen). Wymaga ffmpeg w PATH.' }),
  NT('vid_concat', 'Wideo', 'Połącz klipy', 'merge', { desc: 'Skleja klipy z wejść w jeden plik MP4. Wymaga ffmpeg w PATH.' }),
  NT('if', 'Logika', 'Warunek', 'branch', { desc: 'Przepuszcza dalej tylko, gdy warunek jest spełniony. Przykłady: exit == 0, contains: ERROR, matches: \\d+ failed, empty', fields: [['expr', 'Warunek', 'exit == 0']] }),
  NT('switch', 'Logika', 'Przełącznik', 'branch', { desc: 'Przepuszcza dalej, gdy wejście zawiera jedną z wartości (po przecinku).', fields: [['values', 'Wartości', 'ok, error']] }),
  NT('loop', 'Logika', 'Pętla po liście', 'loop', { desc: 'Wykonuje następny node dla każdej linii wejścia.', fields: [['max', 'Maks. elementów', '20']] }),
  NT('parallel', 'Logika', 'Równolegle', 'split', { desc: 'Przekazuje wejście dalej bez zmian; kolejne nody startują razem.' }),
  NT('delay', 'Logika', 'Opóźnienie', 'timer', { fields: [['sec', 'Sekundy', '5']] }),
  NT('merge', 'Logika', 'Scal', 'merge', { desc: 'Łączy wyniki wszystkich wejść.' }),
  NT('template', 'Dane', 'Szablon tekstu', 'braces', { fields: [['tpl', 'Szablon', 'Wynik: {{input}}']] }),
  NT('jsonpath', 'Dane', 'JSON path', 'braces', { fields: [['path', 'Ścieżka (np. items.0.name)', 'items.0']] }),
  NT('regex', 'Dane', 'Regex', 'filter', { fields: [['pattern', 'Wzorzec', '(\\d+) failed'], ['flags', 'Flagi', 'g']] }),
  NT('var', 'Dane', 'Zmienna', 'braces', { desc: 'Zapisuje wejście pod nazwą; użyj potem {{nazwa}}.', fields: [['name', 'Nazwa', 'wynik']] }),
  NT('split_text', 'Dane', 'Podziel tekst', 'split', { fields: [['sep', 'Separator (\\n = nowa linia)', '\\n']] }),
  NT('join', 'Dane', 'Złącz listę', 'merge', { fields: [['sep', 'Separator', ', ']] }),
  NT('read_file', 'Pliki', 'Czytaj plik', 'file', { fields: [['path', 'Ścieżka', '']] }),
  NT('write_file', 'Pliki', 'Zapisz plik', 'file', { fields: [['path', 'Ścieżka', ''], ['text', 'Treść', '{{input}}']] }),
  NT('list_files', 'Pliki', 'Lista plików', 'folder', { fields: [['dir', 'Katalog', '']] }),
  NT('http', 'Sieć', 'Żądanie HTTP', 'globe', { fields: [['method', 'Metoda', 'GET'], ['url', 'Adres', 'http://localhost:3000/'], ['body', 'Treść', '']] }),
  NT('fetch_page', 'Sieć', 'Pobierz stronę', 'globe', { desc: 'Pobiera stronę i zwraca sam tekst.', fields: [['url', 'Adres', 'https://']] }),
  NT('preview', 'Wyjście', 'Podgląd', 'eye', { desc: 'Pokazuje wynik w ustawieniach noda.' }),
  NT('notify', 'Wyjście', 'Powiadomienie', 'bell', { fields: [['title', 'Tytuł', 'Workflow skończony']] }),
  NT('to_note', 'Wyjście', 'Zapisz w Notatkach', 'note', { fields: [['folder', 'Folder', 'Workflow'], ['title', 'Tytuł', 'Wynik workflow']] }),
  NT('media_save', 'Wyjście', 'Zapisz media', 'save', { desc: 'Kopiuje obrazy i wideo z wejścia do folderu.', fields: [['dir', 'Folder', ''], ['name', 'Nazwa pliku', 'wynik']] }),
  NT('clipboard', 'Wyjście', 'Kopiuj do schowka', 'copy'),
  NT('to_agent', 'Wyjście', 'Wyślij do agenta', 'bot', { desc: 'Dopisuje wynik do czatu agenta workspace\'u.' }),
];

export const DEFAULT_CUSTOM_NODES: NodeTypeDef[] = [
  { id: 'c-secure', cat: 'Własne', name: 'Bezpieczeństwo komendy', icon: 'shield', ai: true, custom: true, desc: 'Ocena ryzyka komendy przed uruchomieniem.',
    defaults: { base: '', prompt: 'Oceń, czy ta komenda jest bezpieczna do uruchomienia na produkcji. Zwróć JSON: {"ryzyko":"niskie|średnie|wysokie","powód":"…"}\n\n{{input}}', provider: 'anthropic', model: 'claude-haiku-5-5', temperature: 0, maxTokens: 600, topP: 1, results: 1, format: 'json' } },
];

export const WS_COLORS = ['var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-1)', 'var(--chart-5)', 'var(--destructive)'];

export function initialState(defaultShell: string): AppState {
  const tabId = 't-first', paneId = 'p-first';
  return {
    version: 1,
    workspaces: [{
      id: 'w-main', name: 'Główny', color: 'var(--chart-2)', mode: 'tabs', agentId: 'boss', subDefault: null,
      tabs: [{ id: tabId, kind: 'terminal', title: 'Terminal', panes: [{ id: paneId, shell: defaultShell }], split: 0.5, splitDir: 'col', subagent: null, win: null }],
      activeTab: tabId, z: [tabId], chat: [],
    }],
    activeWs: 'w-main',
    layout: { side: 240, agent: 320, agentOpen: false, collapsed: {}, palHidden: false },
    settings: {
      undoSec: 20, inactiveDim: 0.6, themeName: 'Domyślny', themeMode: 'system', customThemes: {},
      fontSize: 13, fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace', lineHeight: 1.2, scrollback: 5000,
      cursorBlink: true, lightMode: true, defaultShell, alwaysAsk: ['rm -rf', 'Remove-Item -Recurse', 'format', 'mkfs', 'dd if=', 'shutdown', 'git push --force', 'DROP TABLE'],
      keywords: [{ pattern: '\\b(ERROR|FAIL(ED)?|Exception)\\b', color: 'destructive' }, { pattern: '\\bWARN(ING)?\\b', color: 'chart-3' }],
    },
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p, models: [...p.models] })),
    defModel: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    agents: DEFAULT_AGENTS.map((a) => ({ ...a, tools: [...a.tools] })),
    snippets: DEFAULT_SNIPPETS.map((s) => ({ ...s })),
    prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
    nodeTypes: DEFAULT_CUSTOM_NODES.map((n) => ({ ...n, defaults: { ...n.defaults } })),
    flows: {},
    plugins: [],
    parked: [],
    hosts: [],
    remote: { enabled: false, mode: 'lan', port: 7420, devices: [] },
    local: { comfyDir: '', port: 8188, idleMin: 5, args: '', custom: [] },
  };
}
