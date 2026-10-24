// Decides whether what's on screen is work, neutral, or a distraction.
// Pure functions only, so they are easy to test (see src/test/rules.test.ts).

import type { Activity, Rules, Verdict } from '../shared/types';

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

/** Apps that count as "working" even without a URL. */
const FOCUS_APPS = [
  'Visual Studio Code',
  'Code',
  'Cursor',
  'Xcode',
  'Terminal',
  'iTerm2',
  'Notion',
  'Obsidian',
  'Microsoft Word',
  'Microsoft Excel',
  'Microsoft PowerPoint',
  'Pages',
  'Numbers',
  'Keynote',
  'Preview',
  'TeXShop',
  'RStudio',
  'Concentr8',
  'Electron', // the app itself while running in dev mode
];

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

export function classify(activity: Activity, rules: Rules): Verdict {
  const app = activity.app;

  if (rules.blockedApps.some((a) => a.toLowerCase() === app.toLowerCase())) {
    return { kind: 'distraction', reason: app };
  }

  if (activity.url) {
    const parsed = parseUrl(activity.url);
    if (!parsed) return { kind: 'neutral' };
    const { host, path } = parsed;
    if (rules.allowedDomains.some((r) => matchesDomainRule(r, host, path))) return { kind: 'focus' };
    const hit = rules.blockedDomains.find((r) => matchesDomainRule(r, host, path));
    if (hit) return { kind: 'distraction', reason: hit };
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
    return { kind: 'neutral' };
  }

  if (FOCUS_APPS.some((a) => a.toLowerCase() === app.toLowerCase())) return { kind: 'focus' };
  return { kind: 'neutral' };
}
