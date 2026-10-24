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
  title: string | null; // window title (used for Firefox, which has no URL scripting)
  at: number; // epoch ms
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
}

/** Everything the UI needs, pushed from main to renderer on every change. */
export interface AppState {
  settings: Settings;
  tasks: Task[];
  lastSync: string | null;
  syncError: string | null;
  today: TodayIntent;
  session: FocusSession | null;
  activity: Activity | null;
  verdict: Verdict | null;
  history: SessionSummary[];
  platformSupported: boolean; // monitoring/blocking only works on macOS
  notice: string | null; // one-line status message for the UI
}
