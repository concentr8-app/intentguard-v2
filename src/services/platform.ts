// Talks to macOS through AppleScript (osascript): what's on screen, and how to push it away.
// The first time, macOS asks for permissions:
//   - "Concentr8 wants to control Google Chrome / Safari / System Events" (Automation) -> Allow
//   - Firefox titles and closing Firefox tabs also need Accessibility:
//     System Settings -> Privacy & Security -> Accessibility -> enable Concentr8 (or Electron in dev).

import { execFile } from 'node:child_process';
import type { Activity } from '../shared/types';
import { SCRIPTABLE_BROWSERS, TITLE_ONLY_BROWSERS } from './rules';

export interface Platform {
  supported: boolean;
  activity(): Promise<Activity | null>;
  /** Replace the active tab's page with `url`. */
  redirect(app: string, url: string): Promise<boolean>;
  closeTab(app: string): Promise<boolean>;
  hideApp(app: string): Promise<boolean>;
}

function osascript(lines: string[], timeoutMs = 2500): Promise<string> {
  const args = lines.flatMap((l) => ['-e', l]);
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

/** Makes a value safe to put inside an AppleScript string literal. */
export function asString(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** System Events reports some apps differently ("firefox"); map them to their real names. */
export function canonicalApp(name: string): string {
  const known = [...SCRIPTABLE_BROWSERS, ...TITLE_ONLY_BROWSERS] as string[];
  return known.find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

const isSafari = (app: string) => app === 'Safari';
const isChromium = (app: string) => (SCRIPTABLE_BROWSERS as readonly string[]).includes(app) && !isSafari(app);
const isTitleOnly = (app: string) => (TITLE_ONLY_BROWSERS as readonly string[]).includes(app);

export function createMacPlatform(): Platform {
  let lastProcessName = '';

  return {
    supported: true,

    async activity() {
      let processName: string;
      try {
        processName = await osascript([
          'tell application "System Events" to get name of first application process whose frontmost is true',
        ]);
      } catch {
        return null; // no Automation permission for System Events yet
      }
      lastProcessName = processName;
      const app = canonicalApp(processName);
      let url: string | null = null;
      let title: string | null = null;
      try {
        if (isChromium(app)) {
          url = await osascript([
            `tell application ${asString(app)}`,
            'if (count of windows) > 0 then return URL of active tab of front window',
            'end tell',
          ]);
        } else if (isSafari(app)) {
          url = await osascript([
            'tell application "Safari"',
            'if (count of windows) > 0 then return URL of current tab of front window',
            'end tell',
          ]);
        } else if (isTitleOnly(app)) {
          title = await osascript([
            `tell application "System Events" to tell process ${asString(processName)}`,
            'if (count of windows) > 0 then return name of front window',
            'end tell',
          ]);
        }
      } catch {
        // permission missing or window closing; still report the app
      }
      return { app, url: url || null, title: title || null, at: Date.now() };
    },

    async redirect(app, url) {
      try {
        if (isChromium(app)) {
          await osascript([`tell application ${asString(app)} to set URL of active tab of front window to ${asString(url)}`]);
        } else if (isSafari(app)) {
          await osascript([`tell application "Safari" to set URL of current tab of front window to ${asString(url)}`]);
        } else return false;
        return true;
      } catch {
        return false;
      }
    },

    async closeTab(app) {
      try {
        if (isChromium(app)) {
          await osascript([`tell application ${asString(app)} to close active tab of front window`]);
        } else if (isSafari(app)) {
          await osascript(['tell application "Safari" to close current tab of front window']);
        } else if (isTitleOnly(app)) {
          // Firefox has no tab scripting: press ⌘W, but only if it is still in front.
          const front = await osascript([
            'tell application "System Events" to get name of first application process whose frontmost is true',
          ]);
          if (canonicalApp(front) !== app) return false;
          await osascript(['tell application "System Events" to keystroke "w" using command down']);
        } else return false;
        return true;
      } catch {
        return false;
      }
    },

    async hideApp(app) {
      const processName = canonicalApp(lastProcessName) === app ? lastProcessName : app;
      try {
        await osascript([`tell application "System Events" to set visible of process ${asString(processName)} to false`]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Used on Windows/Linux and in tests: sees nothing, blocks nothing. */
export function createNullPlatform(): Platform {
  return {
    supported: false,
    activity: async () => null,
    redirect: async () => false,
    closeTab: async () => false,
    hideApp: async () => false,
  };
}
