# Concentr8

Getting started is the hard part with ADHD. Concentr8 helps Berkeley students start one task a day:

1. **It knows what's due.** It reads your bCourses (Canvas) assignments.
2. **It calls you at 8:00.** A real phone call reads your next deadlines and asks: *which one will you start with, and when?*
3. **It holds you to it.** At the time you said, focus mode turns on. If you drift to YouTube, Instagram or Discord, it warns you once, then closes the distraction and puts you back on your last work tab.

Built at Cal Hacks 13.0.

## How the pieces fit

```
bCourses ──sync──▶ Mac app ──tasks──▶ Call server (Replit) ──Twilio──▶ your phone
                     ▲                        │
                     └──── your answer ───────┘
                   "the CS 188 project, 9:30" ─▶ focus session starts at 9:30
```

- **Mac app** (`src/`, `renderer/`): Electron. Syncs Canvas, shows today's plan, watches the front window during a session, nudges and blocks.
- **Call server** (`server/`): tiny Node server. Stores tasks, places the morning call through Twilio, saves what you said. Its API is in [`docs/call-server-api.md`](docs/call-server-api.md).

## Run the Mac app

Needs macOS, Node.js 20+ and npm.

```sh
npm install
npm start
```

The first time a session watches your screen, macOS asks whether Concentr8 (shown as *Electron* while developing) may control System Events and your browser. Allow it. Firefox also needs **System Settings → Privacy & Security → Accessibility**.

### Connect bCourses (required)

In bCourses go to **Account → Settings → New access token**, name it Concentr8, and paste the token into the app.
If you can't create a token, open **Calendar → Calendar Feed** in bCourses and paste that link instead.
No account handy? **Try with sample assignments** loads demo data.

The token is stored encrypted in the macOS keychain (Electron `safeStorage`).

### Connect the morning call (optional but the point)

Deploy the call server (see [`server/README.md`](server/README.md)), then in the app open **Settings → Morning call**, paste the server address and the `APP_API_KEY`, and add your phone number. **Call me now** tests it right away.

Without a call server the app still asks you at 8:00 with a notification.

## Demo in two minutes

1. Open the app, **Try with sample assignments**.
2. **Call me now** (or type the plan): say “the CS 188 project” and “now”.
3. The plan appears in your own words; focus mode starts.
4. Open youtube.com in Chrome: a warning, 15 seconds later the tab jumps back to your last work page.
5. Open Discord: it's hidden. The session log shows everything that was caught.

## What blocks what

| You're on | What happens |
|---|---|
| Chrome, Arc, Brave, Edge, Safari | URL checked; distraction tab is sent back to your last work tab (or closed) |
| Firefox | window title checked; distraction tab closed with ⌘W |
| Blocked app (Discord, Steam, Messages …) | app hidden |
| Allowed sites (bCourses, Gradescope, Ed, Docs …) | always fine, and remembered as your work tab |

Change the lists, the warning time (0 = no warning) and the session length in Settings. **Take a 5-min break** pauses blocking.

## Code map

| File | What it does |
|---|---|
| `src/main/index.ts` | Electron window, menu-bar timer, notifications, IPC |
| `src/main/controller.ts` | the daily loop: sync, poll the call server, morning check-in, auto-start |
| `src/main/store.ts` | settings and history as JSON, secrets encrypted |
| `src/services/canvas.ts` | bCourses API (planner items) and calendar-feed fallback |
| `src/services/focus.ts` | the nudge → block → restore engine |
| `src/services/rules.ts` | what counts as work, neutral or distraction |
| `src/services/platform.ts` | AppleScript: read the front app and tab, close or redirect it |
| `src/services/time.ts` | timezone helpers, “nine thirty” → 9:30 |
| `src/services/match.ts` | links what you said to the right Canvas assignment |
| `src/services/callServer.ts` | client for the call server |
| `renderer/` | the UI (plain HTML, CSS, JS) |
| `server/index.js` | the call server |

## Tests

```sh
npm test
```

Covers the blocking engine, rules, spoken-time parsing, Canvas parsing and the full loop
(call answer → plan → session starts at the promised time).

## Build a .app

```sh
npm run build && npx electron-builder --mac --dir
```

The unsigned app lands in `release/mac*/`. Right-click → Open the first time.
