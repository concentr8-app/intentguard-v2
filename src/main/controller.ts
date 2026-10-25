// The app's brain. Knows nothing about windows; index.ts wires it to Electron.
//
// Daily loop:
//   Canvas sync -> tasks pushed to the call server -> 8:00 phone call ("which one, and when?")
//   -> intent pulled back here -> focus session auto-starts at the promised time
//   -> FocusEngine nudges/blocks drift until the session ends.
//
// "I'm stuck" (inside a session):
//   calm screen (interventions paused) -> optional phone call -> one tiny first step with a timer
//   -> "did you get going?" -> back to the session, a smaller step, or a real break.
//   3 separate drifts in 10 minutes offers it. 5 in that window starts the calm screen.

import type {
  AppState,
  DriftEvent,
  FirstStep,
  SessionSummary,
  Settings,
  StuckEpisode,
  StuckOutcome,
  Task,
  TodayIntent,
  UpdateInfo,
} from '../shared/types';
import { CanvasClient, demoTasks, feedTasks, isFeedUrl } from '../services/canvas';
import { CallServerClient, DEFAULT_SERVER_URL } from '../services/callServer';
import { FocusEngine } from '../services/focus';
import { matchTask } from '../services/match';
import type { Platform } from '../services/platform';
import type { CachedSemanticClassifier, RelevanceLog } from '../services/semantic';
import { ServerStepProvider, type StepProvider, suggestFirstStep } from '../services/stuck';
import { localDate, localHHMM, parseSpokenTime } from '../services/time';
import type { Store } from './store';

export interface ControllerDeps {
  appVersion?: string;
  store: Store;
  platform: Platform;
  notify(title: string, body: string): void;
  emit(state: AppState): void;
  showWindow(): void;
  semantic?: CachedSemanticClassifier;
  relevanceLog?: RelevanceLog;
  now?: () => number;
  /** Suggests the first step when stuck; null means fixed steps only. */
  stepProvider?: StepProvider | null;
  /** Opens a page in the student's browser (the task link for the first step). */
  openUrl?(url: string): void;
  log?(message: string): void;
  /** Looks for a newer public release; null when there is none (or the check failed). */
  checkUpdate?(): Promise<UpdateInfo | null>;
}

const FOCUS_TICK_MS = 3_000;
const SERVER_POLL_MS = 60_000;
const CANVAS_SYNC_MS = 15 * 60_000;
const CLOCK_TICK_MS = 20_000;
const UPDATE_CHECK_MS = 6 * 60 * 60_000;

/** Four rounds of box breathing (16 s each) on the calm screen. */
export const CALM_MS = 64_000;
export const CALL_TIMEOUT_MS = 4 * 60_000;
const CALL_POLL_MS = 5_000;
/** This many separate drifts within the window and Concentr8 offers "I'm stuck". */
export const STUCK_OFFER_DRIFTS = 3;
/** This many separate drifts within the same window starts the calm screen. */
export const STUCK_FORCE_DRIFTS = 5;
const STUCK_OFFER_WINDOW_MS = 10 * 60_000;
const STUCK_OFFER_COOLDOWN_MS = 15 * 60_000;
/** Status lines are short-lived: they go away after this long, or as soon as the screen they describe changes. */
export const NOTICE_MS = 15_000;
/** "Calling your phone now…" stays while a call usually lasts; the plan from the call replaces it. */
const CALLING_NOTICE_MS = 3 * 60_000;

export class Controller {
  private readonly focus: FocusEngine;
  private syncError: string | null = null;
  private notice: { text: string; until: number } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private checkInShownFor: string | null = null;
  private autoStartedCommitment: string | null = null;
  private readonly now: () => number;

  // "I'm stuck" state for the running session.
  private stuck: StuckEpisode | null = null;
  private update: UpdateInfo | null = null;
  private stuckOutcomes: StuckOutcome[] = [];
  /** The step being prepared. Replacing or clearing it makes any older request's result stale. */
  private pendingStep: Promise<FirstStep> | null = null;
  private lastCallPollAt = 0;
  private callPolling = false;
  private callPending = false; // the call request is still going out; don't poll yet
  /** firstStepAt the server held before this call: only a different, newer one counts. undefined = unknown. */
  private callBaseline: string | null | undefined = undefined;
  private lastStuckOfferAt = -Infinity;
  /** Drifts at or before this time already led to an episode, so they do not start another. */
  private driftCountFloor = -Infinity;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    this.focus = new FocusEngine({
      platform: deps.platform,
      notify: deps.notify,
      onChange: () => this.emit(),
      rules: () => this.settings.rules,
      graceSeconds: () => this.settings.graceSeconds,
      fallbackUrl: () => (this.settings.canvasConnected ? this.settings.canvasBaseUrl : null),
      semantic: deps.semantic,
      relevanceLog: deps.relevanceLog,
      now: this.now,
      paused: () => this.stuck?.phase === 'calm' || this.stuck?.phase === 'call',
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
      setInterval(() => void this.checkUpdate(), UPDATE_CHECK_MS),
    );
    void this.checkUpdate();
    void this.syncCanvas().then(() => this.pollServer());
    this.clockTick();
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  private async focusTick() {
    const summary = await this.focus.tick();
    if (summary) this.store.addHistory(this.closeStuckForSummary(summary));
    await this.stuckTick();
    this.maybeOfferStuck();
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
      appVersion: this.deps.appVersion ?? 'development',
      update: this.update,
      settings: this.settings,
      tasks: this.store.tasks,
      lastSync: this.store.lastSync,
      syncError: this.syncError,
      today: this.today,
      session: this.focus.session,
      stuck: this.stuck,
      activity: this.focus.activity,
      activityContext: this.focus.activityContext,
      verdict: this.focus.verdict,
      history: this.store.history,
      platformSupported: this.deps.platform.supported,
      notice: this.notice && this.now() < this.notice.until ? this.notice.text : null,
    };
  }

  private emit() {
    this.deps.emit(this.getState());
  }

  /** Shows "a newer version is out" in the app; a failed check changes nothing. */
  async checkUpdate(): Promise<UpdateInfo | null> {
    if (!this.deps.checkUpdate) return null;
    const found = await this.deps.checkUpdate().catch(() => null);
    if (found?.version !== this.update?.version) {
      this.update = found;
      this.emit();
    }
    return found;
  }

  private say(notice: string | null, ms = NOTICE_MS) {
    this.notice = notice ? { text: notice, until: this.now() + ms } : null;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    if (notice) {
      // Repaint once it has expired, even if nothing else changes on screen.
      this.noticeTimer = setTimeout(() => this.emit(), ms + 100);
      (this.noticeTimer as { unref?: () => void }).unref?.(); // never keeps the app (or a test run) alive
    }
    this.emit();
  }

  /** The screen changed, so an earlier status line no longer applies. */
  private clearNotice() {
    this.notice = null;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
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

  /** New student: sign up on the shared server with an invite code, then everything works like a connected server. */
  async signUp(input: { serverUrl?: string; inviteCode: string; phoneNumber: string; callTime: string }): Promise<{ ok: boolean; error?: string }> {
    const serverUrl = (input.serverUrl || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL;
    const phoneNumber = input.phoneNumber.trim();
    const callTime = input.callTime || '08:00';
    if (!phoneNumber) return { ok: false, error: 'Enter your phone number first.' };
    try {
      const { token } = await CallServerClient.register(serverUrl, {
        phoneNumber,
        inviteCode: input.inviteCode.trim(),
        callTime,
        timezone: this.settings.timezone,
      });
      this.store.serverApiKey = token;
      this.store.updateSettings({ serverUrl, serverConnected: true, phoneNumber, callTime });
      await this.pushTasksToServer(this.store.tasks);
      await this.pollServer();
      this.say('Morning calls are on.');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Stops the calls for good and removes this student's data from the server. */
  async deleteAccount(): Promise<{ ok: boolean; error?: string }> {
    const server = this.server();
    if (!server) return { ok: true };
    try {
      await server.deleteAccount();
      this.disconnectServer();
      this.say('Your account on the call server is deleted.');
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
      this.say('Calling your phone now…', CALLING_NOTICE_MS);
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
        this.clearNotice(); // the plan from the call replaces "Calling your phone now…"
        this.deps.notify(
          'Locked in from your call',
          `${remote.focusTask}${remote.startTime ? ` — starting ${remote.startTime}` : ''}`,
        );
      }
      this.store.setToday(next);
      if (!this.settings.serverConnected) this.store.updateSettings({ serverConnected: true });
      this.emit();
      if (changed) this.clockTick();
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
    this.autoStartedCommitment = null;
    this.clearNotice();
    this.emit();
  }

  startFocus(task?: string, minutes?: number) {
    const name = (task || this.today.focusTask || this.store.tasks[0]?.title || 'Deep work').trim();
    const match = matchTask(name, this.store.tasks);
    this.resetStuck();
    this.clearNotice();
    this.focus.start(name, match?.url ?? null, minutes || this.settings.sessionMinutes);
    this.deps.notify('Focus on', `"${name}" for ${minutes || this.settings.sessionMinutes} min. I've got the distractions.`);
  }

  stopFocus() {
    this.clearNotice();
    const summary = this.focus.stop();
    if (summary) this.store.addHistory(this.closeStuckForSummary(summary));
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

  // ---------- "I'm stuck" ----------

  private log(message: string) {
    this.deps.log?.(message);
  }

  /** Starts the calm screen. The first step is fetched in the background meanwhile. */
  imStuck(trigger: StuckEpisode['trigger'] = 'button'): { ok: boolean; error?: string } {
    const session = this.focus.session;
    if (!session) return { ok: false, error: 'Start a focus session first.' };
    if (this.stuck) return { ok: true };
    this.clearNotice();
    const now = this.now();
    const episode: StuckEpisode = {
      startedAt: new Date(now).toISOString(),
      trigger,
      phase: 'calm',
      phaseEndsAt: new Date(now + CALM_MS).toISOString(),
      step: null,
      attempts: 0,
      callAvailable: false,
      callStartedAt: null,
    };
    this.stuck = episode;
    this.lastStuckOfferAt = now; // no "Rough start?" offer on top of an episode the student just started
    this.pendingStep = this.fetchStep(null);
    void this.checkStuckCall(episode);
    this.log(`[stuck] episode started trigger=${trigger}`);
    this.emit();
    return { ok: true };
  }

  /** Calm screen closed (button, Esc or its timer): show the first step. */
  calmDone() {
    const episode = this.stuck;
    if (!episode || episode.phase !== 'calm') return;
    episode.phase = 'step';
    episode.phaseEndsAt = null; // the timer starts once the step is on screen
    this.deps.showWindow();
    this.emit();
    void this.showStep(episode);
  }

  /** The student answers the check-in, or picks an option while the step is shown. */
  stuckAnswer(answer: 'started' | 'smaller' | 'break') {
    const episode = this.stuck;
    if (!episode || (episode.phase !== 'step' && episode.phase !== 'checkin')) return;
    if (answer === 'started') {
      this.finishStuck('started');
      this.say('Nice. The session keeps going.');
      return;
    }
    if (answer === 'break') {
      this.finishStuck('break');
      this.focus.takeBreak(5);
      return;
    }
    if (!episode.step || !episode.step.canRequestSmaller) return; // loading, or the fixed ladder is exhausted
    const previous = episode.step.text;
    episode.phase = 'step';
    episode.step = null;
    episode.phaseEndsAt = null;
    this.pendingStep = this.fetchStep(previous);
    this.emit();
    void this.showStep(episode);
  }

  /**
   * "Talk it through on the phone": only offered when the server announced stuck calls, and only while a step is
   * shown (so there is always something to fall back to). The call phase starts right away, before the request
   * finishes, so the step buttons are gone and a second call can't be placed.
   */
  async stuckCall(): Promise<{ ok: boolean; error?: string }> {
    const episode = this.stuck;
    const server = this.server();
    const session = this.focus.session;
    if (
      !episode ||
      !server ||
      !session ||
      !episode.callAvailable ||
      !episode.step ||
      (episode.phase !== 'step' && episode.phase !== 'checkin')
    ) {
      return { ok: false, error: 'The phone call is not available right now.' };
    }
    const now = this.now();
    episode.phase = 'call';
    episode.callStartedAt = new Date(now).toISOString();
    episode.phaseEndsAt = new Date(now + CALL_TIMEOUT_MS).toISOString();
    this.lastCallPollAt = now;
    this.callPending = true;
    this.emit();
    try {
      // Compare server timestamps with each other, never with this Mac's clock.
      this.callBaseline = await server.today().then(
        (t) => t.firstStepAt ?? null,
        () => undefined,
      );
      await server.callNow({ reason: 'stuck', task: session.task });
    } catch (err) {
      if (this.stuck === episode && episode.phase === 'call') {
        episode.phase = 'step';
        episode.phaseEndsAt = new Date(this.now() + episode.step.minutes * 60_000).toISOString();
        this.emit();
      }
      return { ok: false, error: (err as Error).message };
    } finally {
      this.callPending = false;
    }
    this.log('[stuck] call requested');
    return { ok: true };
  }

  /** Leave the call phase and go back to the step that was already shown or prepared. */
  skipCall() {
    const episode = this.stuck;
    if (!episode || episode.phase !== 'call') return;
    episode.phase = 'step';
    if (episode.step) {
      episode.phaseEndsAt = new Date(this.now() + episode.step.minutes * 60_000).toISOString();
      this.emit();
      return;
    }
    episode.phaseEndsAt = null;
    this.emit();
    void this.showStep(episode);
  }

  cancelStuck() {
    if (this.stuck) this.finishStuck('cancelled');
  }

  /** Called with the focus tick: ends the calm screen, polls the call, starts the check-in. */
  async stuckTick(): Promise<void> {
    const episode = this.stuck;
    if (!episode) return;
    const now = this.now();
    const ends = episode.phaseEndsAt ? Date.parse(episode.phaseEndsAt) : null;

    if (episode.phase === 'calm' && ends !== null && now >= ends) {
      this.calmDone();
      return;
    }

    if (episode.phase === 'call') {
      if (!this.callPending && !this.callPolling && now - this.lastCallPollAt >= CALL_POLL_MS) {
        this.lastCallPollAt = now;
        this.callPolling = true;
        let step: FirstStep | null;
        try {
          step = await this.stepFromCall(episode);
        } finally {
          this.callPolling = false;
        }
        if (this.stuck !== episode || episode.phase !== 'call') return;
        if (step) {
          this.startStepTimer(episode, step);
          this.deps.notify('From your call', step.text);
          this.deps.showWindow();
          return;
        }
      }
      if (ends !== null && now >= ends) {
        this.say("The call didn't come back with a step. Here is one to start with.");
        this.skipCall();
      }
      return;
    }

    if (episode.phase === 'step' && episode.step && ends !== null && now >= ends) {
      episode.phase = 'checkin';
      episode.phaseEndsAt = null;
      this.deps.notify(`${episode.step.minutes} minutes are up`, 'Did you get going?');
      this.deps.showWindow();
      this.emit();
    }
  }

  /**
   * Repeated drifting: 3 separate drifts in 10 minutes offers "I'm stuck".
   * 5 in that same window starts the calm screen. The offer cooldown does not block the force.
   */
  private maybeOfferStuck() {
    const session = this.focus.session;
    if (!session || this.stuck) return;
    const now = this.now();
    if (session.breakUntil && Date.parse(session.breakUntil) > now) return;
    const count = countDriftStarts(session.drifts, Math.max(now - STUCK_OFFER_WINDOW_MS, this.driftCountFloor));
    if (count >= STUCK_FORCE_DRIFTS) {
      this.imStuck('drift');
      this.deps.notify('Let\'s reset', 'Five distractions in 10 minutes. One calm minute, then one tiny step.');
      this.deps.showWindow();
      return;
    }
    if (now - this.lastStuckOfferAt < STUCK_OFFER_COOLDOWN_MS) return;
    if (count < STUCK_OFFER_DRIFTS) return;
    this.lastStuckOfferAt = now;
    this.deps.notify('Rough start?', 'If you feel stuck, press "I\'m stuck" in Concentr8: one calm minute, then one tiny step.');
  }

  private stepInput(previousStep: string | null) {
    const session = this.focus.session;
    const task = session?.task ?? this.today.focusTask ?? 'the task';
    const match = matchTask(task, this.store.tasks);
    return {
      task,
      course: match?.course ?? null,
      taskUrl: session?.taskUrl ?? match?.url ?? null,
      attempt: (this.stuck?.attempts ?? 0) + 1,
      previousStep,
    };
  }

  private fetchStep(previousStep: string | null): Promise<FirstStep> {
    // A local key (development) wins; the downloaded app asks Claude through the call server once signed in.
    const server = this.server();
    const provider = this.deps.stepProvider ?? (server ? new ServerStepProvider(server) : null);
    return suggestFirstStep(provider, this.stepInput(previousStep), (m) => this.log(m));
  }

  private async showStep(episode: StuckEpisode) {
    const pending = this.pendingStep ?? (this.pendingStep = this.fetchStep(episode.step?.text ?? null));
    const step = await pending;
    // Ignore the result if the episode ended, a newer step was requested, or a call took over.
    if (this.stuck !== episode || this.pendingStep !== pending || episode.phase !== 'step' || episode.step) return;
    this.startStepTimer(episode, step);
  }

  private startStepTimer(episode: StuckEpisode, step: FirstStep) {
    this.pendingStep = null;
    const opensPage = episode.attempts === 0 && !!step.url;
    episode.attempts += 1;
    episode.step = step;
    episode.phase = 'step';
    episode.phaseEndsAt = new Date(this.now() + step.minutes * 60_000).toISOString();
    if (opensPage) this.deps.openUrl?.(step.url!);
    this.log(`[stuck] step ${episode.attempts} source=${step.source}`);
    this.emit();
  }

  private async checkStuckCall(episode: StuckEpisode) {
    const server = this.server();
    if (!server) return;
    const available = await server.supportsStuckCall();
    if (this.stuck !== episode || !available) return;
    episode.callAvailable = true;
    this.emit();
  }

  /** The first step the student agreed on during the call, once the server has it. */
  private async stepFromCall(episode: StuckEpisode): Promise<FirstStep | null> {
    const server = this.server();
    if (!server || !episode.callStartedAt) return null;
    try {
      const today = await server.today();
      const text = typeof today.firstStep === 'string' ? today.firstStep.trim() : '';
      const at = today.firstStepAt ?? null;
      if (!text || !at || !Number.isFinite(Date.parse(at))) return null;
      const base = this.callBaseline;
      const fresh =
        base === undefined
          ? Date.parse(at) >= Date.parse(episode.callStartedAt) // baseline unknown: best effort with this Mac's clock
          : base === null || Date.parse(at) > Date.parse(base);
      if (!fresh) return null;
      return { text: text.slice(0, 240), minutes: 5, url: this.stepInput(null).taskUrl, source: 'call', canRequestSmaller: true };
    } catch {
      return null;
    }
  }

  private finishStuck(outcome: StuckOutcome) {
    if (!this.stuck) return;
    this.stuckOutcomes.push(outcome);
    this.log(`[stuck] episode ended outcome=${outcome}`);
    this.stuck = null;
    this.pendingStep = null;
    this.callBaseline = undefined;
    const now = this.now();
    this.lastStuckOfferAt = now; // drifts from before or during the episode don't trigger a new offer
    this.driftCountFloor = now + 1; // `countDriftStarts` includes its start time, so this instant is excluded
    this.emit();
  }

  private resetStuck() {
    this.stuck = null;
    this.stuckOutcomes = [];
    this.pendingStep = null;
  }

  /** Adds the stuck moments to a finished session's summary and clears them. */
  private closeStuckForSummary(summary: SessionSummary): SessionSummary {
    if (this.stuck) this.finishStuck('ended');
    const outcomes = this.stuckOutcomes;
    this.resetStuck();
    if (!outcomes.length) return summary;
    return { ...summary, stuck: outcomes.length, gotGoing: outcomes.filter((o) => o === 'started').length };
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
    // Fingerprint the plan so repeated polls are idempotent without blocking a later commitment that day.
    const commitment = today.startAt
      ? JSON.stringify([today.date, today.focusTask, today.startTime, today.startAt])
      : null;
    const startsAt = today.startAt ? Date.parse(today.startAt) : NaN;
    if (
      commitment &&
      !this.focus.session &&
      this.autoStartedCommitment !== commitment &&
      now.getTime() >= startsAt &&
      now.getTime() - startsAt < 30 * 60_000
    ) {
      this.startFocus(today.focusTask ?? undefined);
      this.autoStartedCommitment = commitment;
      this.deps.showWindow();
    }
  }
}

/** How many separate drifts began since `since`: a warning, or a block that came without one. */
export function countDriftStarts(drifts: DriftEvent[], since: number): number {
  let count = 0;
  for (let i = 0; i < drifts.length; i++) {
    const d = drifts[i];
    if (Date.parse(d.at) < since) continue;
    if (d.action === 'nudged') count++;
    else if (d.action === 'blocked') {
      const prev = drifts[i - 1];
      if (!prev || prev.action !== 'nudged' || prev.target !== d.target) count++;
    }
  }
  return count;
}

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}
