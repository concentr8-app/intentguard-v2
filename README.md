# Concentr8

Concentr8 is an execution-recovery agent, initially focused on Berkeley students with ADHD and executive-function challenges. It helps someone follow through on a chosen task without pretending every distraction is a character flaw or every break is failure.

**Core loop:** intent → observe activity → detect drift → intervene → restore/recover.

New contributors should read [`AGENTS.md`](AGENTS.md) and [`docs/STATUS.md`](docs/STATUS.md) before editing.

Built at Cal Hacks 13.0.

## What works today

- Start a focus session from any typed intent; bCourses is optional.
- Sync bCourses assignments through the Canvas API or calendar-feed fallback.
- Observe the foreground Mac app and, for scriptable browsers, the active page title and full URL including query parameters.
- Optionally classify otherwise-neutral activity with a cached, provider-agnostic semantic check.
- Warn after clear drift, allow a grace period, then redirect or close the distraction and restore the last relevant page.
- Pause interventions during an intentional break.
- Show an in-session intervention log and store ended-session summaries locally.
- Connect to the current call server for scheduled or on-demand check-ins.

Deterministic rules always run first. Only neutral activity can use the optional semantic classifier, and low-confidence or failed requests remain neutral. See [`docs/STATUS.md`](docs/STATUS.md).

## How the pieces fit

```text
typed intent ──────────────┐
bCourses task (optional) ──┼──▶ Electron Mac app ──▶ observe ──▶ warn ──▶ restore
phone answer (optional) ───┘          │
                                      └──▶ local JSON state/history

Electron app ◀── plan/tasks ──▶ Node call server ──▶ Cartesia agent (or Telnyx / Twilio) ──▶ phone
```

- **Mac app** (`src/`, `renderer/`): Electron with a TypeScript main process and plain HTML/CSS/JS renderer.
- **Mac observer** (`src/services/platform.ts`): AppleScript/`osascript` reads and controls the foreground app or browser tab.
- **Call server** (`server/`): Node server that stores tasks, places calls, and saves the user's answer. See [`server/README.md`](server/README.md) and [`docs/call-server-api.md`](docs/call-server-api.md).

## Run the Mac app

Needs macOS, Node.js 20+ and npm.

```sh
npm install
npm start
```

The first time Concentr8 observes or controls another app, macOS may list it as **Electron** while developing. Allow Automation access for System Events and the browser. Firefox/Zen window control also needs **System Settings → Privacy & Security → Accessibility**. Enable Electron notifications in System Settings if you want visible warnings.

### Start without bCourses

Type any task, such as “Build the Concentr8 demo,” commit it, and start focus. This is a normal session even if it matches no assignment.

### Connect bCourses (optional)

In bCourses, go to **Account → Settings → New access token**, name it Concentr8, and paste the token into the app. If token creation is unavailable, open **Calendar → Calendar Feed** and paste that link instead. **Try with sample assignments** works without an account.

The token is stored with Electron `safeStorage` and the macOS keychain.

### Optional semantic relevance

The desktop app works normally without an AI key. For local development, copy the ignored root environment file and fill in your own key:

```sh
cp .env.example .env
# Edit .env and set GROQ_API_KEY. GROQ_MODEL is optional.
npm start
```

`.env` is local-only and must never be committed. Variables already supplied by the shell take precedence over values in the file. User-entered bCourses and call-server secrets continue to use Electron `safeStorage` rather than `.env`.

The semantic layer sends only the current intent, foreground app, page title, and compact URL/search context. It keeps an in-memory cache for the current focus session. Logs distinguish deterministic decisions, semantic API calls, cache hits, and safe fallbacks without printing the key.

### Connect the morning call (optional)

Deploy the call server using [`server/README.md`](server/README.md). In the app, open **Settings → Morning call**, enter the server URL and matching `APP_API_KEY`, and add the phone number. **Call me now** tests the connection. Without a call server, the app can still show its local morning notification.

### Phone carrier and voice

The server uses a **Cartesia voice agent** when `CARTESIA_API_KEY`, `CARTESIA_AGENT_ID` and `CARTESIA_PHONE_NUMBER_ID` are set (setup: [`docs/CARTESIA-SETUP.md`](docs/CARTESIA-SETUP.md)). Otherwise it uses **Telnyx** when `TELNYX_API_KEY` is configured; otherwise it uses **Twilio**. Twilio may require an approved Business profile for calls to +1 numbers. A Telnyx trial can call its verified number.

Amazon Polly is the default voice. Optional ElevenLabs voice through Telnyx requires a paid ElevenLabs plan, `CALL_VOICE=ElevenLabs.Default.<voice_id>`, and `TELNYX_VOICE_KEY_REF=<integration-secret-name>`. Optional Claude responses on the phone use `ANTHROPIC_API_KEY` on the server.

Open `<server-url>/api/health` to see the active carrier and whether required configuration is present; secret values are never returned.

## Demo in two minutes

1. Open the app and either enter an arbitrary task or choose **Try with sample assignments**.
2. Commit the task and click **Start focus**. A connected call server is optional.
3. Keep Concentr8 and Chrome visible side by side: the app shows the foreground app, page title, and full URL.
4. Open `youtube.com`: Concentr8 warns, waits for the configured grace period, then redirects to the last relevant work page or closes the tab.
5. Start a five-minute break to confirm interventions pause, then end the break.
6. End the session to see its local summary.

## What blocks what

| Activity | Current behavior |
|---|---|
| Chrome, Arc, Brave, Edge, Safari | Full URL and title observed; known distractions can be redirected or closed |
| Firefox, Zen | Window title observed; known distraction tabs can be closed with ⌘W |
| Blocked app such as Discord or Steam | App hidden after warning/grace behavior |
| Allowed domains/apps | Never blocked by a conflicting rule; focus still requires direct or semantic relevance |
| Intentional break | Blocking and warnings pause |

Rules, grace time, and session length are editable in Settings. The allowed list is a current heuristic, not proof that a page is relevant to the active intent.

## Limits to know

- Observation and intervention are currently macOS-specific.
- Semantic relevance is optional, provider-dependent, and deliberately conservative.
- The call server must be awake at call time; sleeping deployments need an external request to `/cron/morning?key=…`.
- Provider trials and account verification can limit outbound calls.
- Berkeley bCourses tokens expire after at most 90 days.
- The app is unsigned; right-click → **Open** the first time.

## Developer map

| Path | Responsibility |
|---|---|
| `src/main/index.ts` | Electron lifecycle, notifications, IPC, tray |
| `src/main/controller.ts` | Intent, bCourses sync, call-server polling, session orchestration |
| `src/main/store.ts` | Local JSON settings/history and encrypted secrets |
| `src/services/focus.ts` | Warning → grace → redirect/restore loop and breaks |
| `src/services/rules.ts` | Deterministic activity classification |
| `src/services/semantic.ts` | Provider-independent semantic cache, threshold, and verdict mapping |
| `src/services/groq.ts` | Optional Groq implementation configured from the desktop environment |
| `src/services/platform.ts` | macOS foreground/browser observation and control |
| `src/services/canvas.ts` | bCourses API and calendar-feed fallback |
| `renderer/` | Plain HTML/CSS/JS interface |
| `server/` | Node call server and provider integrations |

Architecture, invariants, ownership, and coding-agent rules live in [`AGENTS.md`](AGENTS.md). Fast-changing verified state and next-step guidance live in [`docs/STATUS.md`](docs/STATUS.md).

## Verify and build

```sh
npm run typecheck
npm test
npm run build
```

Build an unsigned app with:

```sh
npx electron-builder --mac --dir
```

The app lands in `release/mac*/`.
