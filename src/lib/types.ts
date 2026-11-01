export type ThemeMode = 'system' | 'light' | 'dark';
export type PermMode = 'read' | 'ask' | 'auto';

/** `accounts`: konto narzędzia dla tej powłoki (usługa → id konta z `app.accounts`), np. inne logowanie Claude Code. */
export interface Pane { id: string; shell: string; cwd?: string; accounts?: Record<string, string> }

export interface WinGeom { x: number; y: number; w: number; h: number; max: boolean }

export interface Forward { id: string; kind: 'local' | 'remote' | 'dynamic'; bindPort: number; targetHost: string; targetPort: number; auto: boolean }

export interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key' | 'agent';
  keyPath: string;
  /** Hasło albo hasło do klucza w magazynie systemowym. */
  secretRef: string;
  hasSecret: boolean;
  group: string;
  tags: string[];
  distro?: string;
  forwards: Forward[];
  lastUsed?: number;
}

export interface Tab {
  id: string;
  kind: 'terminal' | 'flow' | 'sftp' | 'vault' | 'monitor' | 'gallery';
  hostId?: string;
  title: string;
  /** Jeden albo dwa panele; drugi pojawia się po podziale. */
  panes: Pane[];
  split: number;
  splitDir: 'row' | 'col';
  /** Id profilu podagenta albo null. */
  subagent: string | null;
  win: WinGeom | null;
  flowId?: string;
  /** Panel plików bieżącego katalogu (zakładki terminala) i jego szerokość. */
  files?: boolean;
  filesW?: number;
}

/** Załącznik wiadomości zapisany w `attachments/<rozmowa>/` (wideo jako klatki, plik binarny tylko ze ścieżką). */
export interface Att {
  kind: 'image' | 'video' | 'pdf' | 'text' | 'file' | 'audio';
  name: string;
  path: string;
  size: number;
  mime?: string;
  frames?: { path: string; t: number }[];
  duration?: number;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'agent' | 'sub' | 'system' | 'error';
  who: string;
  text: string;
  att?: Att[];
  /** Zgoda na komendę w zakładce (tabId) albo na wywołanie narzędzia MCP (label). */
  approve?: { tabId?: string; label?: string; command: string; state: 'pending' | 'approved' | 'rejected' };
}

export interface Workspace {
  id: string;
  name: string;
  color: string;
  mode: 'tabs' | 'windows';
  agentId: string;
  subDefault: string | null;
  tabs: Tab[];
  activeTab: string | null;
  z: string[];
  chat: ChatMsg[];
  /** Provider i model wybrane w panelu czatu; bez nich obowiązują ustawienia profilu agenta. */
  /** `key`: wybrany klucz providera; brak = automatycznie (przełączanie przy limicie). */
  chatModel?: { provider: string; model: string; key?: string | null } | null;
  /** Bieżąca rozmowa w historii (chats/<id>.json) i czas jej rozpoczęcia. */
  chatId?: string;
  chatCreated?: number;
}

export type ProviderType = 'anthropic' | 'openai' | 'compat' | 'ollama' | 'google' | 'fal' | 'replicate' | 'comfy';

/** Dodatkowy klucz API providera (np. firmowy obok prywatnego); sam klucz leży w Menedżerze poświadczeń. */
export interface ProviderKey { id: string; name: string; keyRef: string; hasKey: boolean }

export interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  url: string;
  /** Klucz główny (używają go też grafika, wideo, głos i saldo). */
  keyRef: string;
  hasKey: boolean;
  /** Nazwa klucza głównego na listach wyboru. */
  keyName?: string;
  /** Kolejne klucze: czat przełącza się na nie, gdy klucz ma limit albo brak środków. */
  keys?: ProviderKey[];
  /** Model wybierany po wskazaniu samego providera. */
  defModel?: string;
  models: string[];
}

export interface AgentProfile {
  id: string;
  kind: 'agent' | 'sub';
  name: string;
  provider: string;
  model: string;
  /** Klucz providera; brak = automatycznie. */
  key?: string | null;
  perm: PermMode;
  tools: string[];
  prompt: string;
  parallel?: number;
  /** Serwery MCP dostępne dla profilu; brak = wszystkie włączone. */
  mcp?: string[] | null;
  /** Skille przypięte do profilu (id z `app.skills`). */
  skills?: string[];
}

/** Usługi z kontami w narzędziu (logowanie trzyma samo narzędzie w folderze konta). */
export type AccountService = 'claude' | 'codex';
/** Dodatkowe konto Claude Code albo Codex. Konto domyślne (zwykłe logowanie narzędzia) nie ma wpisu. */
export interface ToolAccount { id: string; service: AccountService; name: string }

/** Łańcuch zastępstw: gdy provider odpowie limitem albo brakiem środków, zapytanie idzie do następnego. */
export interface FallbackCfg { enabled: boolean; chain: { provider: string; model: string }[] }

/** Skill: instrukcje (jak SKILL.md) i pliki pomocnicze, które agent wczytuje, gdy zadanie ich wymaga. */
export interface Skill { id: string; name: string; description: string; body: string; files?: Record<string, string> }

/** Serwer MCP: lokalny proces (stdio) albo adres HTTP. Token leży w Menedżerze poświadczeń pod `keyRef`. */
export interface McpServer {
  id: string;
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  keyRef: string;
  hasKey: boolean;
  /** Zmienna środowiskowa, do której trafia token serwera stdio. */
  secretEnv: string;
  enabled: boolean;
}

export interface Snippet { id: string; name: string; kind: 'cmd' | 'ai'; body: string; provider: string | null; model: string | null }

export interface PromptItem { id: string; type: 'folder' | 'prompt'; parent: string | null; name: string; body?: string; open?: boolean }

export interface AiCfg {
  base: string;
  prompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  results: number;
  format: 'text' | 'json' | 'list';
}

export interface NodeTypeDef {
  id: string;
  cat: string;
  name: string;
  icon: string;
  desc?: string;
  ai?: boolean;
  custom?: boolean;
  base?: string;
  format?: AiCfg['format'];
  fields?: [string, string, string][];
  defaults?: Partial<AiCfg> & Record<string, any>;
  /** Node generujący grafikę albo wideo (rodzaj operacji). */
  media?: MediaOp;
}

/** Operacje nodów mediów: tekst→obraz, edycja obrazu, tekst→wideo, obraz→wideo, powiększenie, usunięcie tła. */
export type MediaOp = 'image' | 'edit' | 'video' | 'i2v' | 'upscale' | 'rmbg';
export interface Media { kind: 'image' | 'video'; path: string; seed?: number }
export interface MediaCfg {
  base: string;
  prompt: string;
  provider: string;
  model: string;
  n: number;
  aspect: string;
  duration: string;
  seed: string;
  negative: string;
  imageKey: string;
  params: string;
}

export interface FlowNode {
  id: string;
  type: string;
  x: number;
  y: number;
  label: string;
  cfg: Record<string, any>;
}

export interface Flow { id: string; nodes: FlowNode[]; edges: [string, string][]; sx?: number; sy?: number }

export interface PluginRecord { id: string; enabled: boolean; config: Record<string, string | number | boolean>; builtin: boolean }

export interface ParkedTab { tab: Tab; wsId: string; wsName: string; index: number; by: string }

export interface ThemeVars { [k: string]: string }
export interface ThemeDef { light?: ThemeVars | null; dark?: ThemeVars | null; imported?: boolean; /** Czcionki z Google Fonts (z layout.tsx albo zmiennych --font-*). */ fonts?: string[] }

export interface Settings {
  /** Język interfejsu: auto (z systemu), pl, en. */
  lang: string;
  undoSec: number;
  inactiveDim: number;
  themeName: string;
  themeMode: ThemeMode;
  customThemes: Record<string, ThemeDef>;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  scrollback: number;
  cursorBlink: boolean;
  lightMode: boolean;
  defaultShell: string;
  alwaysAsk: string[];
  keywords: { pattern: string; color: string }[];
}

export interface Layout { side: number; agent: number; agentOpen: boolean; collapsed: Record<string, boolean>; palHidden: boolean }

export interface AppState {
  version: 1;
  workspaces: Workspace[];
  activeWs: string;
  layout: Layout;
  settings: Settings;
  providers: Provider[];
  defModel: { provider: string; model: string };
  agents: AgentProfile[];
  snippets: Snippet[];
  prompts: PromptItem[];
  nodeTypes: NodeTypeDef[];
  flows: Record<string, Flow>;
  plugins: PluginRecord[];
  parked: ParkedTab[];
  /** Zużycie tokenów i ostatnie limity per provider (licznik w ai.ts, czyta je plugin Quota). */
  usage: Record<string, import('./usage').ProviderUsage>;
  /** Modele oznaczone gwiazdką: na górze listy w panelu czatu. */
  starred: { provider: string; model: string }[];
  mcp: McpServer[];
  hosts: Host[];
  remote: RemoteCfg;
  local: LocalCfg;
  monitor: MonitorCfg;
  accounts: ToolAccount[];
  fallback: FallbackCfg;
  skills: Skill[];
  voice: VoiceCfg;
}

/** Głos: dyktowanie (nagranie zamieniane na tekst u providera) i czytanie odpowiedzi agentów. */
export interface VoiceCfg {
  /** Provider zgodny z OpenAI do zamiany mowy na tekst ('' = pierwszy pasujący z kluczem). */
  sttProvider: string;
  sttModel: string;
  /** Kod języka nagrań albo 'auto' (model rozpoznaje sam). */
  lang: string;
  /** Wiadomość głosowa: wysyłka zaraz po nagraniu zamiast wstawienia tekstu do pola. */
  autoSend: boolean;
  /** Nagranie zostaje w rozmowie jako załącznik do odsłuchania. */
  keepAudio: boolean;
  /** Które odpowiedzi czytać na głos. */
  speak: 'off' | 'agent' | 'all';
  /** Głosy systemu (offline) albo /audio/speech providera. */
  engine: 'system' | 'provider';
  sysVoice: string;
  rate: number;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  /** Wskazówki dla modeli, które je przyjmują (np. gpt-4o-mini-tts): tempo, ton. */
  ttsStyle: string;
}

/** Monitoring: kolumny, odświeżanie (s) i hosty SSH dołączone do tabeli. */
export interface MonitorCfg { cols: string[]; interval: number; hosts: string[] }

/** Workflow ComfyUI zaimportowany przez użytkownika (format API). */
export interface ComfyCustom { id: string; name: string; op: MediaOp; graph: Record<string, any>; created: number }
/** Lokalne AI: ComfyUI uruchamiany na żądanie i zatrzymywany po bezczynności. */
export interface LocalCfg {
  comfyDir: string; port: number; idleMin: number; args: string; custom: ComfyCustom[];
  /** Katalog modeli pobrany z repozytorium (aktualizowany raz na dobę). */
  catalog?: { at: number; data: unknown };
}

export interface RemoteDevice { id: string; name: string; perm: 'view' | 'control' | 'full'; added: number; lastSeen?: number }
export interface RemoteCfg { enabled: boolean; mode: 'lan' | 'tailscale'; port: number; devices: RemoteDevice[] }

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion?: number;
  main: string;
  author?: string;
  description?: string;
  icon?: string;
  permissions: string[];
  contributes?: {
    sidebar?: { id: string; title: string; icon?: string }[];
    statusBar?: { id: string; alignment?: string; priority?: number }[];
    commands?: { id: string; title: string; keybinding?: string }[];
    tabMenu?: { id: string; title: string; icon?: string; when?: string }[];
    /** Komenda pluginu otwierająca jego własne okno ustawień (przycisk w Ustawienia → Pluginy). */
    settingsCommand?: string;
  };
  config?: Record<string, string | number | boolean>;
}
