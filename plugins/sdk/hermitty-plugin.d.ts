/**
 * Hermitty Plugin API, wersja 1.
 *
 * Plugin to moduł ES (`main` w plugin.json) eksportujący `activate(tx)` i opcjonalnie `deactivate()`.
 * Kod pluginu działa w izolowanym iframe (osobny origin, CSP bez dostępu do sieci). Każde wywołanie `tx.*`
 * idzie przez host w Ruście, który sprawdza uprawnienia zadeklarowane w plugin.json.
 *
 * Czego nie ma w API i nigdy nie będzie: magazynu poświadczeń, kluczy API providerów, haseł z Vaulta,
 * surowych naciśnięć klawiszy w terminalu ani odczytu schowka w tle.
 */

export type Permission =
  | 'storage'
  | 'ui:sidebar' | 'ui:statusbar' | 'ui:tab' | 'ui:commands'
  | 'notifications'
  | 'system:info'
  | 'terminal:read' | 'terminal:write'
  | 'ai:invoke' | 'ai:usage'
  | 'ai:plans'                  // tylko pluginy wbudowane
  | 'net:localhost' | 'net:*'
  | 'fs:read' | 'fs:write'
  | 'shell:exec'
  | 'tabs:manage'
  | 'ui:tabmenu'
  | 'vault:keys';               // tylko pluginy wbudowane w aplikację; import .zip je odrzuca

export interface Disposable { dispose(): void }

export interface Limit { limit: number; remaining: number; reset: number }
export interface ProviderUsage {
  day: string; dayIn: number; dayOut: number;
  month: string; monthIn: number; monthOut: number;
  totalIn: number; totalOut: number; calls: number; last: number;
  limits?: { tokens?: Limit; input?: Limit; output?: Limit; requests?: Limit; at: number };
}

export interface PluginManifest {
  id: string;                 // odwrócona domena, np. "acme.hello"
  name: string;
  version: string;            // semver
  apiVersion: 1;
  main: string;               // ścieżka do modułu ES w archiwum
  author?: string;
  description?: string;
  icon?: string;              // nazwa ikony lucide albo ścieżka do .svg w archiwum
  homepage?: string;
  minAppVersion?: string;
  permissions: Permission[];
  contributes?: {
    sidebar?: { id: string; title: string; icon?: string }[];
    statusBar?: { id: string; alignment?: 'left' | 'right'; priority?: number }[];
    commands?: { id: string; title: string; keybinding?: string }[];
    tabTypes?: { id: string; title: string; icon?: string }[];
    /** Pozycje w menu kontekstowym zakładki (PPM). Wymaga 'ui:tabmenu'. */
    tabMenu?: { id: string; title: string; icon?: string; when?: 'terminal' | 'any' }[];
  };
  /** Domyślna konfiguracja. Klucze i typy wartości wyznaczają formularz w Ustawieniach → Pluginy. */
  config?: Record<string, string | number | boolean>;
}

export interface FsEntry { name: string; path: string; kind: 'file' | 'dir'; size: number; modified: number }

/** Pliki w katalogu danych pluginu. Ścieżki są względne i nie mogą wyjść poza ten katalog. */
export interface PluginStorage {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  readJson<T = unknown>(path: string, fallback?: T): Promise<T>;
  writeJson(path: string, value: unknown): Promise<void>;
  list(dir: string): Promise<FsEntry[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Usuwa od razu, bez kosza. Do sprzątania własnych plików tymczasowych. */
  remove(path: string): Promise<void>;
  /**
   * Przenosi do kosza pluginu. Host pokazuje standardowe powiadomienie z „Przywróć”
   * i usuwa na stałe po czasie z Ustawień → Ogólne (domyślnie 20 s).
   */
  trash(path: string, opts: { label: string }): Promise<void>;
  onChange(cb: (paths: string[]) => void): Disposable;
}

export interface SidebarAction { id: string; icon: string; title: string; run(): void | Promise<void> }
/**
 * Sekcja w pasku bocznym. Nagłówek (nazwa, ikona, akcje, licznik) rysuje host, więc każda sekcja
 * zwija się do samej belki tak samo. Stan zwinięcia host zapamiętuje per plugin.
 */
export interface SidebarSection {
  id: string;
  title: string;
  icon?: string;
  actions?: SidebarAction[];
  /** Liczba w nagłówku, widoczna także po zwinięciu. Można ją zmieniać przez zwrócony uchwyt. */
  badge?: number;
  /** Sekcja przyjmuje zakładki upuszczone z paska zakładek. Wymaga 'tabs:manage'. */
  onTabDrop?(tabId: string): void | Promise<void>;
  /** Wywoływane raz. `el` żyje w dokumencie pluginu; zmienne motywu (--background, --primary…) są już ustawione. */
  render(el: HTMLElement): void | Disposable;
}

export interface StatusBarItem extends Disposable {
  text: string;
  tooltip?: string;
  icon?: string;
  variant?: 'default' | 'warning' | 'error';
  /** Gdzie widać element: dolny pasek statusu (domyślnie) albo górny pasek okna. */
  place?: 'top' | 'bottom';
  onClick?: () => void;
  show(): void;
  hide(): void;
}

export interface DialogHandle { close(): void }
export interface DialogOptions {
  title: string;
  width?: number;
  render(el: HTMLElement, handle: DialogHandle): void;
  onClose?(): void;
}

export interface SectionHandle extends Disposable {
  setBadge(n: number | null): void;
  /** Rozwija sekcję, np. po dodaniu do niej elementu. */
  reveal(): void;
}

export interface TabInfo {
  id: string;
  title: string;
  kind: 'terminal' | 'workflow' | 'sftp' | 'monitor' | string;
  shell?: string;                       // 'pwsh' | 'cmd' | 'wsl:Ubuntu' …
  workspaceId: string;
  workspaceName: string;
  /** Proces pierwszoplanowy w terminalu (z drzewa procesów, nie z wpisanych znaków). */
  process?: { command: string; pid: number; startedAt: number; idleShell: boolean };
  parked: boolean;
}

export interface PluginTabs {
  list(): Promise<TabInfo[]>;
  get(id: string): Promise<TabInfo | null>;
  /**
   * Zdejmuje zakładkę z workspace'u bez zamykania procesu. Host zapamiętuje workspace i pozycję.
   * Zakładkę zaparkowaną przez plugin może przywrócić tylko ten plugin (albo host po wyłączeniu pluginu).
   */
  park(id: string): Promise<void>;
  /** Odkłada zakładkę na jej poprzednie miejsce (albo do aktywnego workspace'u, jeśli tamten zamknięto). */
  unpark(id: string, opts?: { focus?: boolean }): Promise<void>;
  /** Zamyka zakładkę z tym samym 20-sekundowym cofnięciem co w UI. */
  close(id: string, opts: { label: string }): Promise<void>;
  /** Ostatnie linie wyjścia, z wyciętymi liniami po monitach o hasło. Wymaga 'terminal:read'. */
  tail(id: string, lines: number): Promise<string[]>;
  onChanged(cb: (tabs: TabInfo[]) => void): Disposable;
}

export interface PluginUi {
  sidebar: { registerSection(section: SidebarSection): SectionHandle };
  tabMenu: { onSelect(cb: (itemId: string, tabId: string) => void): Disposable };   // 'ui:tabmenu'
  statusBar: { createItem(opts: { id: string; alignment?: 'left' | 'right'; priority?: number }): StatusBarItem };
  commands: { register(id: string, title: string, run: () => void, opts?: { keybinding?: string }): Disposable };
  dialog: {
    open(opts: DialogOptions): DialogHandle;
    confirm(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  };
  notify(opts: { title: string; body?: string; level?: 'info' | 'success' | 'warning' | 'error' }): void;
  openExternal(url: string): Promise<void>;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface TxApi {
  plugin: { id: string; version: string };
  platform: { os: 'windows' | 'linux' | 'macos'; appVersion: string };
  config: {
    get<T extends string | number | boolean>(key: string): T;
    all(): Record<string, string | number | boolean>;
    onChange(cb: (key: string) => void): Disposable;
  };
  storage: PluginStorage;                                   // 'storage'
  ui: PluginUi;                                             // 'ui:*', 'notifications'
  system: { stats(): Promise<{ cpu: number; memUsed: number; memTotal: number }> };   // 'system:info'
  shell: { exec(cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }): Promise<ExecResult> }; // 'shell:exec'
  net: { fetch(url: string, init?: RequestInit): Promise<Response> };                // 'net:localhost' | 'net:*'
  terminal: {                                                                         // 'terminal:read' | 'terminal:write'
    list(): Promise<{ id: string; title: string; shell: string; workspaceId: string }[]>;
    onOutput(id: string, cb: (text: string) => void): Disposable;   // linie z monitami o hasło są wycięte
    write(id: string, text: string): Promise<void>;
  };
  tabs: PluginTabs;                                                                   // 'tabs:manage'
  ai: {                                                                               // 'ai:invoke'
    complete(opts: { prompt: string; system?: string; provider?: string; model?: string; maxTokens?: number }): Promise<string>;
    /** 'ai:usage': zużycie tokenów i limity z nagłówków per provider (bez kluczy i treści). */
    usage(): Promise<{ providers: { id: string; name: string; type: string; host: string }[]; usage: Record<string, ProviderUsage> }>;
    /** 'ai:usage': saldo konta (OpenRouter, DeepSeek) albo null. */
    balance(providerId: string): Promise<{ text: string; remaining: number | null; limit: number | null; currency: string } | null>;
    onUsage(cb: () => void): Disposable;
    /** 'ai:plans' (tylko wbudowane): zużycie planu subskrypcji z logowania narzędzia na tym komputerze.
     *  Usługi: claude, codex, gemini, cursor, zai, opencode, openrouter. Błąd = nie da się teraz odczytać (powód w treści). */
    plan(service: string): Promise<{ plan: string; text?: string; windows: { label: string; usedPercent: number; resetsAt: number }[] }>;
  };
  /** Sejf kluczy ('vault:keys', tylko wbudowane): klucz wpisuje się w oknie hosta i trafia do magazynu
   *  poświadczeń systemu. Plugin dostaje tylko wersję zamaskowaną; kopiowanie robi host. */
  keys: {
    add(id: string, opts?: { title?: string; message?: string }): Promise<{ masked: string } | null>;
    masked(ids: string[]): Promise<Record<string, string | null>>;
    copy(id: string, label?: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  events: {
    on(event: 'workspace:changed' | 'tab:opened' | 'tab:closed' | 'theme:changed', cb: (payload: unknown) => void): Disposable;
  };
}

export interface PluginModule {
  activate(tx: TxApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
