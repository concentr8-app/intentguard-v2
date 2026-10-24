// The app's brain. Knows nothing about windows; index.ts wires it to Electron.
//
// Daily loop:
//   Canvas sync -> tasks pushed to the call server -> 8:00 phone call ("which one, and when?")
//   -> intent pulled back here -> focus session auto-starts at the promised time
//   -> FocusEngine nudges/blocks drift until the session ends.

import type { AppState, Settings, Task, TodayIntent } from '../shared/types';
import { CanvasClient, demoTasks, feedTasks, isFeedUrl } from '../services/canvas';
import { CallServerClient } from '../services/callServer';
import { FocusEngine } from '../services/focus';
import { matchTask } from '../services/match';
import type { Platform } from '../services/platform';
import { localDate, localHHMM, parseSpokenTime } from '../services/time';
import type { Store } from './store';

export interface ControllerDeps {
  store: Store;
  platform: Platform;
  notify(title: string, body: string): void;
  emit(state: AppState): void;
  showWindow(): void;
  now?: () => number;
}

const FOCUS_TICK_MS = 3_000;
const SERVER_POLL_MS = 60_000;
const CANVAS_SYNC_MS = 15 * 60_000;
const CLOCK_TICK_MS = 20_000;

export class Controller {
  private readonly focus: FocusEngine;
  private syncError: string | null = null;
  private notice: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private checkInShownFor: string | null = null;
  private autoStartedFor: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.focus = new FocusEngine({
      platform: deps.platform,
      notify: deps.notify,
      onChange: () => this.emit(),
      rules: () => this.settings.rules,
      graceSeconds: () => this.settings.graceSeconds,
      fallbackUrl: () => (this.settings.canvasConnected ? this.settings.canvasBaseUrl : null),
      now: this.now,
    });
  }

  private get store() {
    return this.deps.store;
  }
  private get settings(): Settings {
    return this.store.settings;
  }

  // ---------- lifecycle ----------

  start() {
    this.timers.push(
      setInterval(() => void this.focusTick(), FOCUS_TICK_MS),
      setInterval(() => void this.pollServer(), SERVER_POLL_MS),
      setInterval(() => void this.syncCanvas(), CANVAS_SYNC_MS),
      setInterval(() => this.clockTick(), CLOCK_TICK_MS),
    );
    void this.syncCanvas().then(() => this.pollServer());
    this.clockTick();
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async focusTick() {
    const summary = await this.focus.tick();
    if (summary) this.store.addHistory(summary);
  }

  // ---------- state ----------

  private emptyToday(): TodayIntent {
    return {
      date: localDate(new Date(this.now()), this.settings.timezone),
      focusTask: null,
      startTime: null,
      startAt: null,
      source: null,
      lastCallAt: null,
      lastCallStatus: null,
    };
  }

  /** Today's intent, reset automatically after midnight. */
  get today(): TodayIntent {
    const t = this.store.today;
    const date = localDate(new Date(this.now()), this.settings.timezone);
    return t && t.date === date ? t : this.emptyToday();
  }

  getState(): AppState {
    return {
      settings: this.settings,
      tasks: this.store.tasks,
      lastSync: this.store.lastSync,
      syncError: this.syncError,
      today: this.today,
      session: this.focus.session,
      activity: this.focus.activity,
      activityContext: this.focus.activityContext,
      verdict: this.focus.verdict,
      history: this.store.history,
      platformSupported: this.deps.platform.supported,
      notice: this.notice,
    };
  }

  private emit() {
    this.deps.emit(this.getState());
  }

  private say(notice: string | null) {
    this.notice = notice;
    this.emit();
  }

  // ---------- Canvas ----------

  /** `secret` is a personal access token, or the calendar feed link as a fallback. */
  async connectCanvas(baseUrl: string, secret: string): Promise<{ ok: boolean; error?: string }> {
    const base = (baseUrl || this.settings.canvasBaseUrl).trim();
    const value = secret.trim();
    if (!value) return { ok: false, error: 'Paste your token or calendar feed link first.' };
    try {
      if (isFeedUrl(value)) {
        await feedTasks(value, this.settings.timezone);
        this.store.canvasToken = value;
        this.store.updateSettings({ canvasConnected: true, canvasFeed: true, canvasUserName: null, demoMode: false });
        await this.syncCanvas();
        this.say('Connected to your bCourses calendar feed.');
        return { ok: true };
      }
      const name = await new CanvasClient(base, value).whoAmI();
      this.store.canvasToken = value;
      this.store.updateSettings({ canvasBaseUrl: base, canvasConnected: true, canvasFeed: false, canvasUserName: name, demoMode: false });
      await this.syncCanvas();
      this.say(`Connected to Canvas as ${name}.`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async useDemo() {
    this.store.updateSettings({ demoMode: true, canvasConnected: false, canvasFeed: false, canvasUserName: 'Demo Student' });
    await this.syncCanvas();
    this.say('Demo mode: sample Berkeley assignments loaded.');
  }

  disconnectCanvas() {
    this.store.disconnectCanvas();
    this.say('Canvas disconnected.');
  }

  async syncCanvas(): Promise<void> {
    let tasks: Task[] | null = null;
    if (this.settings.demoMode) {
      tasks = demoTasks(new Date(this.now()));
    } else if (this.settings.canvasConnected && this.store.canvasToken) {
      try {
        tasks = this.settings.canvasFeed
          ? await feedTasks(this.store.canvasToken, this.settings.timezone)
          : await new CanvasClient(this.settings.canvasBaseUrl, this.store.canvasToken).upcomingTasks();
        this.syncError = null;
      } catch (err) {
        this.syncError = (err as Error).message;
      }
    }
    if (tasks) {
      this.store.setTasks(tasks);
      await this.pushTasksToServer(tasks);
    }
    this.emit();
  }

  // ---------- call server ----------

  private server(): CallServerClient | null {
    const key = this.store.serverApiKey;
    if (!this.settings.serverUrl || !key) return null;
    return new CallServerClient(this.settings.serverUrl, key);
  }

  async connectServer(url: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
    const client = new CallServerClient(url, apiKey.trim());
    try {
      await client.health();
      await client.today(); // proves the API key works
      this.store.serverApiKey = apiKey.trim();
      this.store.updateSettings({ serverUrl: url.trim().replace(/\/+$/, ''), serverConnected: true });
      await this.pushSettingsToServer();
      await this.pushTasksToServer(this.store.tasks);
      await this.pollServer();
      this.say('Call server connected.');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  disconnectServer() {
    this.store.serverApiKey = null;
    this.store.updateSettings({ serverConnected: false });
    this.say('Call server disconnected.');
  }

  private async pushTasksToServer(tasks: Task[]) {
    const server = this.server();
    if (!server || tasks.length === 0) return;
    try {
      await server.pushTasks(tasks);
    } catch (err) {
      this.syncError = (err as Error).message;
    }
  }

  private async pushSettingsToServer() {
    const server = this.server();
    if (!server) return;
    const { phoneNumber, callTime, timezone } = this.settings;
    try {
      await server.saveSettings({ ...(phoneNumber ? { phoneNumber } : {}), callTime, timezone });
    } catch (err) {
      this.say((err as Error).message);
    }
  }

  async callNow(): Promise<{ ok: boolean; error?: string }> {
    const server = this.server();
    if (!server) return { ok: false, error: 'Connect the call server first (Settings).' };
    try {
      await this.pushTasksToServer(this.store.tasks);
      await server.callNow();
      this.say('Calling your phone now…');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Pulls what the student said on the phone. */
  async pollServer(): Promise<void> {
    const server = this.server();
    if (!server) return;
    try {
      const remote = await server.today();
      const local = this.today;
      const changed =
        remote.focusTask !== null &&
        (remote.focusTask !== local.focusTask || remote.startTime !== local.startTime);
      const next: TodayIntent = {
        ...local,
        lastCallAt: remote.lastCallAt,
        lastCallStatus: remote.lastCallStatus,
      };
      if (changed && remote.date === local.date) {
        next.focusTask = remote.focusTask;
        next.startTime = remote.startTime;
        next.startAt = this.parseStart(remote.startTime);
        next.source = 'call';
        this.deps.notify(
          'Locked in from your call',
          `${remote.focusTask}${remote.startTime ? ` — starting ${remote.startTime}` : ''}`,
        );
      }
      this.store.setToday(next);
      if (!this.settings.serverConnected) this.store.updateSettings({ serverConnected: true });
      this.emit();
    } catch (err) {
      this.syncError = (err as Error).message;
      this.emit();
    }
  }

  private parseStart(spoken: string | null): string | null {
    if (!spoken) return null;
    const at = parseSpokenTime(spoken, new Date(this.now()), this.settings.timezone);
    return at ? at.toISOString() : null;
  }

  // ---------- intent & focus ----------

  /** Typed in the app instead of said on the phone. */
  setIntent(focusTask: string, startTime: string) {
    const t = this.today;
    this.store.setToday({
      ...t,
      focusTask: focusTask.trim() || null,
      startTime: startTime.trim() || null,
      startAt: this.parseStart(startTime.trim() || null),
      source: 'app',
    });
    this.autoStartedFor = null;
    this.emit();
  }

  startFocus(task?: string, minutes?: number) {
    const name = (task || this.today.focusTask || this.store.tasks[0]?.title || 'Deep work').trim();
    const match = matchTask(name, this.store.tasks);
    this.focus.start(name, match?.url ?? null, minutes || this.settings.sessionMinutes);
    this.autoStartedFor = this.today.date;
    this.deps.notify('Focus on', `"${name}" for ${minutes || this.settings.sessionMinutes} min. I've got the distractions.`);
  }

  stopFocus() {
    const summary = this.focus.stop();
    if (summary) this.store.addHistory(summary);
    this.emit();
  }

  takeBreak(minutes: number) {
    this.focus.takeBreak(minutes);
  }

  endBreak() {
    this.focus.endBreak();
  }

  saveSettings(patch: Partial<Settings>) {
    const allowed: (keyof Settings)[] = ['phoneNumber', 'callTime', 'timezone', 'graceSeconds', 'sessionMinutes', 'rules', 'canvasBaseUrl'];
    const clean: Partial<Settings> = {};
    for (const k of allowed) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
    this.store.updateSettings(clean);
    void this.pushSettingsToServer();
    this.emit();
  }

  // ---------- clock: morning check-in & auto-start ----------

  clockTick() {
    const now = new Date(this.now());
    const tz = this.settings.timezone;
    const today = this.today;
    const hhmm = localHHMM(now, tz);

    // 1) Morning check-in. With a call server the phone rings; without one, the app asks.
    if (hhmm >= this.settings.callTime && this.checkInShownFor !== today.date && !today.focusTask) {
      const minutesLate = minutesBetween(this.settings.callTime, hhmm);
      if (minutesLate <= 90) {
        this.checkInShownFor = today.date;
        if (!this.server()) {
          this.deps.notify('Good morning ☀️', "What's the one thing you'll start with today?");
          this.deps.showWindow();
        }
      }
    }

    // 2) Start the session at the time the student promised.
    if (
      today.startAt &&
      !this.focus.session &&
      this.autoStartedFor !== today.date &&
      now.getTime() >= Date.parse(today.startAt) &&
      now.getTime() - Date.parse(today.startAt) < 30 * 60_000
    ) {
      this.startFocus(today.focusTask ?? undefined);
      this.deps.showWindow();
    }
  }
}

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}
