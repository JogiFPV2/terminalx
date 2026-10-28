export type ThemeMode = 'system' | 'light' | 'dark';
export type PermMode = 'read' | 'ask' | 'auto';

export interface Pane { id: string; shell: string; cwd?: string }

export interface WinGeom { x: number; y: number; w: number; h: number; max: boolean }

export interface Forward { id: string; kind: 'local' | 'remote' | 'dynamic'; bindPort: number; targetHost: string; targetPort: number; auto: boolean }

export interface Host {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
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
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'agent' | 'sub' | 'system' | 'error';
  who: string;
  text: string;
  approve?: { tabId: string; command: string; state: 'pending' | 'approved' | 'rejected' };
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
}

export type ProviderType = 'anthropic' | 'openai' | 'compat' | 'ollama' | 'google' | 'fal' | 'replicate' | 'comfy';

export interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  url: string;
  keyRef: string;
  hasKey: boolean;
  models: string[];
}

export interface AgentProfile {
  id: string;
  kind: 'agent' | 'sub';
  name: string;
  provider: string;
  model: string;
  perm: PermMode;
  tools: string[];
  prompt: string;
  parallel?: number;
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
  hosts: Host[];
  remote: RemoteCfg;
  local: LocalCfg;
  monitor: MonitorCfg;
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
  };
  config?: Record<string, string | number | boolean>;
}
