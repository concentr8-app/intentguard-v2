// Types shared by the main process, the services and (as documentation) the renderer.

/** One thing the student has to do, normalized from Canvas. */
export interface Task {
  id: string;
  title: string;
  course: string;
  dueAt: string | null; // ISO timestamp
  url: string | null; // link to the assignment in Canvas
  kind: 'assignment' | 'quiz' | 'discussion' | 'note' | 'other';
}

/** What the student committed to today (from the morning call or typed in the app). */
export interface TodayIntent {
  date: string; // YYYY-MM-DD in the student's timezone
  focusTask: string | null;
  startTime: string | null; // as spoken, e.g. "nine a.m."
  startAt: string | null; // parsed ISO timestamp, if we could understand startTime
  source: 'call' | 'app' | null;
  lastCallAt: string | null;
  lastCallStatus: string | null;
}

/** What the Mac is showing right now. */
export interface Activity {
  app: string; // frontmost application name, e.g. "Google Chrome"
  url: string | null; // active tab URL for browsers that expose it
  title: string | null; // active page title, or the window title for browsers without URL scripting
  at: number; // epoch ms
}

/** Everything a classifier needs to judge observed activity relative to the active commitment. */
export interface ActivityContext {
  activity: Activity;
  intent: string;
}

export type Verdict =
  | { kind: 'focus' } // clearly work (Canvas, Docs, IDE …)
  | { kind: 'neutral' }
  | { kind: 'distraction'; reason: string };

export interface DriftEvent {
  at: string; // ISO
  target: string; // domain or app name
  action: 'nudged' | 'blocked' | 'returned';
}

export interface FocusSession {
  task: string;
  taskUrl: string | null; // where "back to work" sends you
  startedAt: string;
  endsAt: string;
  breakUntil: string | null;
  drifts: DriftEvent[];
}

export interface Rules {
  blockedDomains: string[]; // "youtube.com", "linkedin.com/feed"
  blockedApps: string[]; // "Discord"
  allowedDomains: string[]; // always fine, wins over blocked
}

export interface Settings {
  canvasBaseUrl: string;
  canvasConnected: boolean;
  canvasFeed: boolean; // connected through the calendar feed link instead of a token
  canvasUserName: string | null;
  demoMode: boolean;
  serverUrl: string;
  serverConnected: boolean;
  phoneNumber: string;
  callTime: string; // HH:MM
  timezone: string;
  graceSeconds: number;
  sessionMinutes: number;
  rules: Rules;
}

export interface SessionSummary {
  task: string;
  startedAt: string;
  endedAt: string;
  minutes: number;
  drifts: number;
  blocks: number;
  stuck?: number; // stuck moments during the session (missing in older history entries)
  gotGoing?: number; // how many of them ended with "I'm going"
}

// ---------- "I'm stuck": calm down, connect, one tiny first step, check in ----------

/**
 * calm    full-screen breathing screen, interventions paused
 * call    the phone is ringing / the student is talking it through, interventions paused
 * step    one tiny first step with a short timer; normal watching resumes
 * checkin the timer is up: "did you get going?"
 */
export type StuckPhase = 'calm' | 'call' | 'step' | 'checkin';

export interface FirstStep {
  text: string; // one concrete action, e.g. "Open the spec and read only the first section."
  minutes: number;
  url: string | null; // page to open for it (only the task's own link, never one a model made up)
  source: 'claude' | 'fallback' | 'call';
}

export interface StuckEpisode {
  startedAt: string;
  trigger: 'button' | 'shortcut' | 'drift';
  phase: StuckPhase;
  phaseEndsAt: string | null; // end of the calm screen or of the step timer
  step: FirstStep | null;
  attempts: number; // steps offered so far; each retry asks for a smaller one
  callAvailable: boolean; // the call server says it can do a stuck call
  callStartedAt: string | null;
}

export type StuckOutcome = 'started' | 'break' | 'cancelled' | 'ended';

/** Everything the UI needs, pushed from main to renderer on every change. */
export interface AppState {
  appVersion: string;
  settings: Settings;
  tasks: Task[];
  lastSync: string | null;
  syncError: string | null;
  today: TodayIntent;
  session: FocusSession | null;
  stuck: StuckEpisode | null;
  activity: Activity | null;
  activityContext: ActivityContext | null;
  verdict: Verdict | null;
  history: SessionSummary[];
  platformSupported: boolean; // monitoring/blocking only works on macOS
  notice: string | null; // one-line status message for the UI
}
