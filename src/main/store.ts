// Saves settings, cached tasks and history as JSON in the app's data folder.
// Secrets (Canvas token, server API key) are encrypted with the macOS keychain via safeStorage.

import fs from 'node:fs';
import path from 'node:path';
import type { Rules, SessionSummary, Settings, Task, TodayIntent } from '../shared/types';
import { BERKELEY_CANVAS } from '../services/canvas';
import { DEFAULT_SERVER_URL } from '../services/callServer';
import { DEFAULT_RULES } from '../services/rules';

export interface Crypto {
  available(): boolean;
  encrypt(plain: string): string; // base64
  decrypt(cipher: string): string;
}

interface Persisted {
  settings: Settings;
  secrets: { canvasToken?: string; serverApiKey?: string; encrypted?: boolean };
  tasks: Task[];
  lastSync: string | null;
  today: TodayIntent | null;
  history: SessionSummary[];
}

/**
 * Default call servers of earlier versions. Older installs saved the default address in their settings,
 * so an update kept talking to a retired server. Students who never connected move to the current one.
 */
const RETIRED_DEFAULT_SERVERS = ['https://intentguard-v-2.replit.app'];

export function defaultSettings(): Settings {
  return {
    canvasBaseUrl: BERKELEY_CANVAS,
    canvasConnected: false,
    canvasFeed: false,
    canvasUserName: null,
    demoMode: false,
    serverUrl: DEFAULT_SERVER_URL,
    serverConnected: false,
    phoneNumber: '',
    callTime: '08:00',
    timezone: 'America/Los_Angeles',
    graceSeconds: 15,
    sessionMinutes: 50,
    rules: structuredClone(DEFAULT_RULES),
  };
}

export class Store {
  private data: Persisted;
  private readonly file: string;

  constructor(dir: string, private readonly crypto: Crypto) {
    this.file = path.join(dir, 'concentr8.json');
    this.data = this.load();
  }

  private load(): Persisted {
    const empty: Persisted = { settings: defaultSettings(), secrets: {}, tasks: [], lastSync: null, today: null, history: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persisted>;
      const settings = { ...defaultSettings(), ...(raw.settings ?? {}) };
      settings.rules = { ...DEFAULT_RULES, ...(raw.settings?.rules ?? {}) } as Rules;
      const savedServer = String(settings.serverUrl || '').trim().replace(/\/+$/, '').toLowerCase();
      if (!settings.serverConnected && RETIRED_DEFAULT_SERVERS.includes(savedServer)) settings.serverUrl = DEFAULT_SERVER_URL;
      return { ...empty, ...raw, settings };
    } catch {
      return empty;
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file); // atomic: never leaves a half-written file
  }

  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
  }

  private setSecret(key: 'canvasToken' | 'serverApiKey', value: string | null) {
    const s = this.data.secrets;
    if (value === null || value === '') delete s[key];
    else s[key] = this.crypto.available() ? this.crypto.encrypt(value) : value;
    s.encrypted = this.crypto.available();
    this.save();
  }

  private getSecret(key: 'canvasToken' | 'serverApiKey'): string | null {
    const v = this.data.secrets[key];
    if (!v) return null;
    if (!this.data.secrets.encrypted) return v;
    try {
      return this.crypto.decrypt(v);
    } catch {
      return null;
    }
  }

  get canvasToken() {
    return this.getSecret('canvasToken');
  }
  set canvasToken(v: string | null) {
    this.setSecret('canvasToken', v);
  }
  get serverApiKey() {
    return this.getSecret('serverApiKey');
  }
  set serverApiKey(v: string | null) {
    this.setSecret('serverApiKey', v);
  }

  get tasks() {
    return this.data.tasks;
  }
  get lastSync() {
    return this.data.lastSync;
  }
  setTasks(tasks: Task[]) {
    this.data.tasks = tasks;
    this.data.lastSync = new Date().toISOString();
    this.save();
  }

  get today() {
    return this.data.today;
  }
  setToday(today: TodayIntent) {
    this.data.today = today;
    this.save();
  }

  get history() {
    return this.data.history;
  }
  addHistory(entry: SessionSummary) {
    this.data.history = [entry, ...this.data.history].slice(0, 50);
    this.save();
  }

  /** Forget the Canvas connection (and demo mode). */
  disconnectCanvas() {
    this.setSecret('canvasToken', null);
    this.data.settings = { ...this.data.settings, canvasConnected: false, canvasFeed: false, canvasUserName: null, demoMode: false };
    this.data.tasks = [];
    this.data.lastSync = null;
    this.save();
  }
}
