// The execution-recovery loop: during a focus session, look at the screen every few seconds,
// nudge on drift, block if the drift continues, and send the student back to the last relevant tab.

import type { Activity, ActivityContext, DriftEvent, FocusSession, Rules, SessionSummary, Verdict } from '../shared/types';
import type { Platform } from './platform';
import { SCRIPTABLE_BROWSERS, TITLE_ONLY_BROWSERS } from './rules';
import { CachedSemanticClassifier, classifyWithSemantic, type RelevanceLog } from './semantic';

export interface FocusDeps {
  platform: Platform;
  notify(title: string, body: string): void;
  onChange(): void;
  rules(): Rules;
  graceSeconds(): number;
  fallbackUrl(): string | null; // e.g. the Canvas dashboard
  semantic?: CachedSemanticClassifier;
  relevanceLog?: RelevanceLog;
  now?: () => number;
  /** True while something else (the "I'm stuck" calm screen or call) owns the moment: no nudges, no blocks. */
  paused?: () => boolean;
}

/** After a block, the same distraction is blocked again without a second warning for this long. */
/**
 * Only real pages can be restored. Browser start pages such as Safari's `favorites://` fail to
 * load when set by script ("WebKitErrorDomain:101"), so they are never remembered as a work tab.
 */
export function isRestorableUrl(url: string | null | undefined): url is string {
  return !!url && /^(https?|file):\/\//i.test(url.trim());
}

const REPEAT_WINDOW_MS = 2 * 60_000;

export class FocusEngine {
  session: FocusSession | null = null;
  activity: Activity | null = null;
  activityContext: ActivityContext | null = null;
  verdict: Verdict | null = null;

  private drift: { target: string; since: number } | null = null;
  private lastBlocked = new Map<string, number>();
  private lastRelevantUrl: string | null = null;
  private busy = false;
  private readonly now: () => number;

  constructor(private readonly deps: FocusDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(task: string, taskUrl: string | null, minutes: number): FocusSession {
    const startedAt = this.now();
    this.session = {
      task,
      taskUrl,
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + minutes * 60_000).toISOString(),
      breakUntil: null,
      drifts: [],
    };
    this.drift = null;
    this.lastBlocked.clear();
    this.lastRelevantUrl = null;
    this.activityContext = null;
    this.deps.semantic?.clear();
    this.deps.onChange();
    return this.session;
  }

  /** Ends the session and returns a summary for the history list. */
  stop(): SessionSummary | null {
    const s = this.session;
    if (!s) return null;
    const endedAt = this.now();
    const summary: SessionSummary = {
      task: s.task,
      startedAt: s.startedAt,
      endedAt: new Date(endedAt).toISOString(),
      minutes: Math.max(0, Math.round((endedAt - Date.parse(s.startedAt)) / 60_000)),
      drifts: s.drifts.filter((d) => d.action === 'nudged').length,
      blocks: s.drifts.filter((d) => d.action === 'blocked').length,
    };
    this.session = null;
    this.drift = null;
    this.activityContext = null;
    this.verdict = null;
    this.deps.semantic?.clear();
    this.deps.onChange();
    return summary;
  }

  /** A planned break: nothing gets blocked until it's over. */
  takeBreak(minutes: number): void {
    if (!this.session) return;
    this.session.breakUntil = new Date(this.now() + minutes * 60_000).toISOString();
    this.drift = null;
    this.deps.onChange();
  }

  endBreak(): void {
    if (!this.session) return;
    this.session.breakUntil = null;
    this.deps.onChange();
  }

  /** Called every few seconds. Returns a summary if the session just finished. */
  async tick(): Promise<SessionSummary | null> {
    if (!this.session || this.busy) return null;
    this.busy = true;
    try {
      return await this.step(this.session);
    } finally {
      this.busy = false;
    }
  }

  private log(target: string, action: DriftEvent['action']) {
    this.session?.drifts.push({ at: new Date(this.now()).toISOString(), target, action });
  }

  private async step(session: FocusSession): Promise<SessionSummary | null> {
    const now = this.now();
    if (now >= Date.parse(session.endsAt)) {
      const summary = this.stop();
      if (summary) {
        this.deps.notify('Session done', `${summary.minutes} min on "${summary.task}". Take a real break.`);
      }
      return summary;
    }

    const activity = await this.deps.platform.activity();
    if (this.session !== session) return null; // stopped while we were looking
    this.activity = activity;
    if (!activity) {
      this.activityContext = null;
      this.verdict = null;
      this.deps.onChange();
      return null;
    }
    this.activityContext = { activity, intent: session.task };
    const verdict = await classifyWithSemantic(
      this.activityContext,
      this.deps.rules(),
      this.deps.semantic,
      this.deps.relevanceLog,
    );
    if (this.session !== session) return null; // stopped while semantic classification was pending
    this.verdict = verdict;

    const onBreak = session.breakUntil !== null && now < Date.parse(session.breakUntil);
    if (session.breakUntil !== null && !onBreak) session.breakUntil = null;

    if (verdict.kind !== 'distraction') {
      if (this.drift) {
        this.log(this.drift.target, 'returned');
        this.drift = null;
      }
      if (isRestorableUrl(activity.url)) {
        if (verdict.kind === 'focus' || !this.lastRelevantUrl) this.lastRelevantUrl = activity.url;
      }
      this.deps.onChange();
      return null;
    }

    if (onBreak || this.deps.paused?.()) {
      this.drift = null;
      this.deps.onChange();
      return null;
    }

    const target = verdict.reason;
    const grace = Math.max(0, this.deps.graceSeconds()) * 1000;
    const recentlyBlocked = now - (this.lastBlocked.get(target) ?? -Infinity) < REPEAT_WINDOW_MS;

    if (!this.drift || this.drift.target !== target) {
      this.drift = { target, since: now };
      if (grace > 0 && !recentlyBlocked) {
        this.log(target, 'nudged');
        this.deps.notify(
          `Back to: ${session.task}`,
          `${target} isn't part of the plan. Switch back within ${Math.round(grace / 1000)}s or I'll close it.`,
        );
        this.deps.onChange();
        return null;
      }
    }

    if (recentlyBlocked || now - this.drift.since >= grace) {
      await this.block(activity, target, session);
      this.lastBlocked.set(target, now);
      this.drift = null;
      this.log(target, 'blocked');
    }
    this.deps.onChange();
    return null;
  }

  private async block(activity: Activity, target: string, session: FocusSession) {
    const { platform } = this.deps;
    const app = activity.app;
    let done = false;
    let where = '';
    if ((SCRIPTABLE_BROWSERS as readonly string[]).includes(app)) {
      const back = [this.lastRelevantUrl, session.taskUrl, this.deps.fallbackUrl()].find(isRestorableUrl);
      if (back) {
        done = await platform.redirect(app, back);
        where = back === this.lastRelevantUrl ? 'your last work tab' : back === session.taskUrl ? 'the assignment' : 'your courses';
      }
      if (!done) done = await platform.closeTab(app);
    } else if ((TITLE_ONLY_BROWSERS as readonly string[]).includes(app)) {
      done = await platform.closeTab(app);
    } else {
      done = await platform.hideApp(app);
    }
    this.deps.notify(
      done ? `Closed ${target}` : `Still on ${target}?`,
      done
        ? `Back to "${session.task}"${where ? ` — I opened ${where}` : ''}.`
        : `I couldn't close it (check permissions). You said you'd do "${session.task}".`,
    );
  }
}
