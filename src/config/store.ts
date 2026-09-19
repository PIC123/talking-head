import { type Config, assignDeep, cloneConfig, defaultConfig, migrate } from './schema';

const KEY = 'talking-head:config';
const PRESET_KEY = (slot: number) => `talking-head:preset:${slot}`;

type Listener = (cfg: Config) => void;
type Broadcaster = (cfg: Config) => void;

/** Single source of truth for all tunables. Autosaves to localStorage 500 ms after any change. */
export class ConfigStore {
  cfg: Config;
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;
  private broadcaster: Broadcaster | null = null;
  private applyingRemote = false;
  private broadcastQueued = false;

  constructor() {
    this.cfg = this.loadFromStorage() ?? defaultConfig();
  }

  private loadFromStorage(): Config | null {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? migrate(JSON.parse(raw)) : null;
    } catch (e) {
      console.warn('config load failed', e);
      return null;
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Call after mutating `cfg` in place. */
  touch(): void {
    for (const l of this.listeners) l(this.cfg);
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 500);
    if (this.broadcaster && !this.applyingRemote && !this.broadcastQueued) {
      // Coalesce a drag's many touches into one message per frame.
      this.broadcastQueued = true;
      requestAnimationFrame(() => {
        this.broadcastQueued = false;
        this.broadcaster?.(this.cfg);
      });
    }
  }

  /** Mirror every change to another tab. */
  setBroadcaster(b: Broadcaster | null): void {
    this.broadcaster = b;
  }

  /** Apply a config received from another tab without echoing it back. */
  applyRemote(next: Config): void {
    this.applyingRemote = true;
    try {
      assignDeep(this.cfg, migrate(next));
      this.touch();
    } finally {
      this.applyingRemote = false;
    }
  }

  /** Replace all values but keep object identity, so panel bindings stay live. */
  replace(next: Config): void {
    assignDeep(this.cfg, next);
    this.touch();
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.cfg));
    } catch (e) {
      console.warn('config save failed', e);
    }
  }

  reset(): void {
    this.replace(defaultConfig());
  }

  savePreset(slot: number): void {
    try {
      localStorage.setItem(PRESET_KEY(slot), JSON.stringify(this.cfg));
    } catch (e) {
      console.warn('preset save failed', e);
    }
  }

  loadPreset(slot: number): boolean {
    try {
      const raw = localStorage.getItem(PRESET_KEY(slot));
      if (!raw) return false;
      this.replace(migrate(JSON.parse(raw)));
      return true;
    } catch (e) {
      console.warn('preset load failed', e);
      return false;
    }
  }

  exportJson(): string {
    return JSON.stringify(this.cfg, null, 2);
  }

  importJson(text: string): void {
    this.replace(migrate(JSON.parse(text)));
  }

  snapshot(): Config {
    return cloneConfig(this.cfg);
  }
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      f.text().then(resolve, () => resolve(null));
    };
    input.click();
  });
}
