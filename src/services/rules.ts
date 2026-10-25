// Decides whether what's on screen is work, neutral, or a distraction.
// Pure functions only, so they are easy to test (see src/test/rules.test.ts).

import type { Activity, ActivityContext, Rules, Verdict } from '../shared/types';

export const DEFAULT_RULES: Rules = {
  blockedDomains: [
    'youtube.com',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'x.com',
    'twitter.com',
    'facebook.com',
    'netflix.com',
    'twitch.tv',
    'hulu.com',
    'disneyplus.com',
    'primevideo.com',
    'pinterest.com',
    '9gag.com',
    'linkedin.com/feed',
  ],
  blockedApps: ['Discord', 'Steam', 'Messages', 'WhatsApp', 'Telegram', 'TV'],
  allowedDomains: [
    'bcourses.berkeley.edu',
    'berkeley.edu',
    'instructure.com',
    'gradescope.com',
    'edstem.org',
    'piazza.com',
    'docs.google.com',
    'overleaf.com',
    'github.com',
    'localhost',
  ],
};

const SELF_APPS = ['Concentr8', 'Electron']; // the app itself while running in dev mode

const RELEVANCE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'app',
  'assignment',
  'build',
  'complete',
  'continue',
  'course',
  'courses',
  'dashboard',
  'demo',
  'do',
  'document',
  'docs',
  'finish',
  'for',
  'from',
  'github',
  'google',
  'home',
  'homework',
  'in',
  'into',
  'login',
  'make',
  'my',
  'of',
  'on',
  'page',
  'project',
  'search',
  'start',
  'task',
  'the',
  'this',
  'to',
  'with',
  'work',
  'working',
]);

/** Browsers whose active tab URL we can read and change via AppleScript. */
export const SCRIPTABLE_BROWSERS = [
  'Google Chrome',
  'Arc',
  'Brave Browser',
  'Microsoft Edge',
  'Safari',
] as const;

/** Browsers we can only see through the window title. */
export const TITLE_ONLY_BROWSERS = ['Firefox', 'Zen'] as const;

export function isBrowser(app: string): boolean {
  return (
    (SCRIPTABLE_BROWSERS as readonly string[]).includes(app) ||
    (TITLE_ONLY_BROWSERS as readonly string[]).includes(app)
  );
}

function isExplicitBlankUrl(raw: string): boolean {
  const url = raw.trim().toLowerCase();
  if (url === 'about:blank' || url === 'about:newtab') return true;
  // Safari's start page (Favorites / Top Sites).
  if (/^(favorites|topsites):\/\//.test(url)) return true;
  return /^(chrome|edge|brave|arc):\/\/(newtab|new-tab-page)\/?(?:[?#].*)?$/.test(url);
}

/** Exact empty/new-tab cases only; real pages titled "New Tab" are not included. */
export function isBlankBrowserActivity(activity: Activity): boolean {
  if (!isBrowser(activity.app)) return false;
  if (activity.url && isExplicitBlankUrl(activity.url)) return true;
  return activity.title?.trim().toLowerCase() === 'new tab' && !activity.url?.trim();
}

/** "https://www.youtube.com/watch?v=1" -> { host: "youtube.com", path: "/watch" } */
export function parseUrl(raw: string): { host: string; path: string } | null {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) return null;
    return { host: u.hostname.replace(/^www\./, '').toLowerCase(), path: u.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Does a rule like "linkedin.com/feed" match this URL?
 * The domain part matches the host or any subdomain; an optional path part must be a prefix.
 */
export function matchesDomainRule(rule: string, host: string, path: string): boolean {
  const clean = rule.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (!clean) return false;
  const slash = clean.indexOf('/');
  const ruleHost = slash === -1 ? clean : clean.slice(0, slash);
  const rulePath = slash === -1 ? '' : clean.slice(slash);
  const hostOk = host === ruleHost || host.endsWith('.' + ruleHost);
  return hostOk && (rulePath === '' || path.startsWith(rulePath));
}

/** Short label for a rule, used when matching window titles ("youtube.com" -> "youtube"). */
function titleKeyword(rule: string): string {
  const host = rule.toLowerCase().replace(/^www\./, '').split('/')[0];
  const parts = host.split('.');
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
}

function relevanceTokens(text: string): Set<string> {
  const raw = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]+/g) ?? [];
  const expanded = [...raw];

  // Join course codes written with a space ("math 185") without splitting words such as
  // "Concentr8" or "HW8" into a generic digit that could match an unrelated task.
  for (let i = 0; i < raw.length - 1; i++) {
    if (/^[a-z]{2,4}$/.test(raw[i]) && /^\d{2,3}$/.test(raw[i + 1])) expanded.push(raw[i] + raw[i + 1]);
  }

  return new Set(
    expanded.filter((token) => {
      if (RELEVANCE_STOP_WORDS.has(token)) return false;
      if (/^\d+$/.test(token)) return token.length >= 2;
      return token.length >= 3;
    }),
  );
}

function activityEvidence(context: ActivityContext): string {
  const parts = [context.activity.title ?? ''];
  if (!context.activity.url) return parts.join(' ');
  try {
    const url = new URL(context.activity.url);
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed escape should not prevent title or query evidence from being considered.
    }
    parts.push(path, ...url.searchParams.values());
  } catch {
    // Invalid URLs provide no trustworthy structured evidence.
  }
  return parts.join(' ');
}

function hasStrongIntentOverlap(context: ActivityContext): boolean {
  const intent = relevanceTokens(context.intent);
  const evidence = relevanceTokens(activityEvidence(context));
  const shared = [...intent].filter((token) => evidence.has(token));
  const sharedWords = shared.filter((token) => /[a-z]/.test(token));

  if (sharedWords.some((token) => /[a-z]\d|\d[a-z]/.test(token))) return true;
  if (sharedWords.some((token) => token.length >= 7)) return true;
  return shared.length >= 2 && sharedWords.length >= 1;
}

function isDirectCanvasTask(host: string, path: string): boolean {
  const canvas = host === 'bcourses.berkeley.edu' || host.endsWith('.instructure.com');
  return canvas && /\/courses\/[^/]+\/(assignments|quizzes|discussion_topics)\/[^/]+(?:\/|$)/.test(path);
}

export function classify(context: ActivityContext, rules: Rules): Verdict {
  const { activity } = context;
  const app = activity.app;

  if (isBlankBrowserActivity(activity)) return { kind: 'neutral' };

  if (rules.blockedApps.some((a) => a.toLowerCase() === app.toLowerCase())) {
    return { kind: 'distraction', reason: app };
  }

  if (activity.url) {
    const parsed = parseUrl(activity.url);
    if (!parsed) return { kind: 'neutral' };
    const { host, path } = parsed;
    const allowed = rules.allowedDomains.some((r) => matchesDomainRule(r, host, path));
    const hit = rules.blockedDomains.find((r) => matchesDomainRule(r, host, path));
    if (hit && !allowed) return { kind: 'distraction', reason: hit };
    if (isDirectCanvasTask(host, path) || hasStrongIntentOverlap(context)) return { kind: 'focus' };
    return { kind: 'neutral' };
  }

  // Firefox & co.: no URL, so we look at the window title ("Funny cats - YouTube — Mozilla Firefox").
  if (activity.title && isBrowser(app)) {
    const title = activity.title.toLowerCase();
    const hit = rules.blockedDomains.find((r) => {
      const kw = titleKeyword(r);
      // "x" would match everything; only use keywords that are long enough to be meaningful.
      const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return kw.length >= 4 && new RegExp(`\\b${safe}\\b`).test(title);
    });
    if (hit) return { kind: 'distraction', reason: hit };
  }

  if (hasStrongIntentOverlap(context)) return { kind: 'focus' };
  if (SELF_APPS.some((a) => a.toLowerCase() === app.toLowerCase())) return { kind: 'focus' };
  return { kind: 'neutral' };
}
