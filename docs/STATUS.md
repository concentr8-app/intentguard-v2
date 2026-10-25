# Concentr8 status

This file records fast-changing implementation status. Keep durable product and workflow rules in [`../AGENTS.md`](../AGENTS.md).

## Current main

- Code baseline for the blank/new-tab neutrality milestone: `618e1a6` (`origin/main` on 2026-10-24).
- Use `git log -1 --oneline` to identify the implementation commit layered on this baseline.

## Proven working

Supported by current code and the verification recorded below. Observer and intervention flows also received manual verification before the documentation pass; the relevance milestone was intentionally verified with automated checks only.

- Sessions start from arbitrary typed intents, including intents that do not match bCourses.
- Foreground Mac application monitoring through AppleScript/`osascript`.
- Active page-title capture for scriptable browsers.
- Complete active URL capture, including query parameters.
- `ActivityContext` carries both the observed activity and active intent to classification.
- Conservative deterministic relevance recognizes strong intent overlap in page titles, URL paths, and query values.
- Direct Canvas assignment, quiz, and discussion resources remain focus.
- Generic productive sites and apps, including unrelated GitHub pages, remain neutral unless relevance is strong.
- Otherwise-neutral activity can optionally use Groq through a provider-independent interface.
- Semantic results use a `0.85` confidence threshold; uncertainty, low confidence, missing configuration, and API failures remain neutral.
- Semantic classifications are cached by intent plus activity for the current session, preventing repeated calls from unchanged three-second polls.
- Unpackaged Electron development loads an ignored root `.env` without overriding existing shell variables.
- Explicit blank/new-tab browser activity, including Safari's start page (`favorites://`), remains neutral and bypasses semantic requests. Only `http(s)`/`file` pages are remembered and restored as the last work tab.
- Direct bCourses sync and calendar-feed fallback.
- Visible warning, grace period, and redirect/restore behavior for configured distractions.
- Intentional breaks pause interventions and can be ended to resume monitoring.
- The in-session intervention log is visible, and ended-session summaries are stored locally.
- The call-server client/API and Telnyx/Twilio provider implementations are present on main.
- Optional ElevenLabs voice through Telnyx and optional Claude phone-response handling are present on the server.

Real provider calls still depend on valid credentials, account state, phone verification, and a reachable deployment. Their presence in main is not a claim that every provider account is currently ready.

### "I'm stuck" recovery flow (on main; automated tests only so far)

- `STUCK` is now a real state in the desktop app: calm → (optional) call → step → check-in, held in `Controller` and shown in `AppState.stuck`.
- **Calm:** a full-screen breathing screen (`renderer/calm.html`) for up to 60 s; Esc or "I'm ready" ends it early. Warnings and blocking pause during calm and call.
- **Step:** one tiny first step with a timer (usually 5 min). Claude (`src/services/stuck.ts`, `ANTHROPIC_API_KEY`) suggests it from the task and course; without a key or on any failure a fixed step is used, and each "Still stuck" gets a smaller one. The task's own bCourses link opens once; Claude never chooses URLs.
- **Check-in:** "Did you get going?" → back to the session, a smaller step, or a real 5-minute break.
- **Offer, then force:** 3 separate drifts within 10 minutes trigger a notification offering "I'm stuck". 5 separate drifts within that same window start the calm screen. A warning followed by its block counts as one drift. Drifts that already led to an episode do not start another one.
- **Phone call:** offered only when the call server announces `stuck-call` (proposal in `docs/call-server-api.md`); a 4-minute timeout falls back to the prepared step.
- Stuck moments are counted in session summaries (`stuck`, `gotGoing`).
- Global shortcut **⌃⌥⌘S** starts it from any app, registered only while a session runs (not ⌥⌘S: that is "Save All" in VS Code). If another app owns the chord, the button and menu item still work.

### Simpler start (branch `simpler-start`)

- No bCourses gate: the app opens on "What's the one thing you'll start today?". "Add your courses" (bCourses) and "Add sample assignments" are offered in the task list and in Settings, worded as an invitation so students who start right away still add their courses.
- Typing a task and pressing Enter starts the session at once ("Start now"); typing a time first plans it instead ("Plan it"), and it starts by itself at that time.
- Verified by rendering the window with a stubbed `window.c8` in Chromium; not yet on a real Mac.
- Verified: 15 new tests in `src/test/stuck.test.ts` (flow, pause, fallbacks, call, timeout, old server). Not yet verified: `npm run typecheck`/`build` with real Electron types, the calm window on a real Mac (multi-display, full-screen apps), and a live Claude call.

Latest automated verification on Node.js `v26.7.0`:

- `npm run typecheck`: passed.
- `npm test`: passed, 30/30 tests.
- `npm run build`: passed.

## Call server (partner-owned workstream)

- One server serves many students: `POST /api/register` (invite code + consent) returns a personal token; `APP_API_KEY` stays the owner key; per-student phone, call time, timezone, tasks, daily call caps, "stop" on the phone, `DELETE /api/me`.
- The app signs students up in Settings → Morning call; "I run my own call server" keeps the API-key path.
- This is deliberately lightweight (invite code + token), not production authentication. No phone verification yet.
- Calls go through a Cartesia voice agent when its secrets are set (`docs/CARTESIA-SETUP.md`), otherwise Telnyx, then Twilio. The agent saves the plan through `POST /cartesia/save-plan`.
- 17 server tests: `cd server && npm test` (the phone providers are faked). Not yet checked live: Cartesia agent setup, calls to people other than the owner (a Telnyx trial calls only verified numbers).

## Current known limitations

- Semantic classification requires an optional provider key and network connection; the app remains deterministic without them.
- Ambiguous activity intentionally remains neutral and is not blocked.
- Explicit deterministic distractions never reach semantic classification, even if a page title could be educational.
- The semantic cache is in-memory and session-local; there is no long-term AI memory.
- An unrelated NFL search during Math homework is neutral rather than assumed on-task or blocked.
- `STUCK` is a first-class state on the `stuck-flow` branch; `RECOVERING` is not yet a separate state. The stuck call needs the server changes proposed in `docs/call-server-api.md`.
- Observation and intervention are macOS-specific; other platforms use a no-op observer.
- macOS permissions and provider/deployment setup can affect demo reliability.

## Current product direction

Planning guidance, not an immutable roadmap:

Completed: conservative, task-aware deterministic relevance.

Completed: provider-agnostic semantic classification for neutral activity, with optional Groq support.

In review: the “I'm stuck” recovery flow (desktop side), with stuck episodes counted per session.

1. User correction such as “This is actually work.”
2. Explicit recovery metrics beyond stuck episodes (time back on task after a drift).
3. Server side of the stuck call (partner-owned).
4. A richer intervention ladder if time remains.

Plan and ship one bounded milestone at a time. Re-evaluate this sequence using demo reliability and observed user behavior.

## Current ownership and coordination

- Calling/provider work remains partner-owned.
- Desktop, recovery, and relevance work should avoid modifying `server/` without coordination.
- New teammates must choose a bounded subsystem or task before implementation.
- Fetch `origin/main` and inspect local status before editing because work can land from multiple workstreams.

## Do not start yet

- React or Chrome-extension rewrite.
- Screenshot collection or screenshot-based classification.
- Reinforcement learning/contextual bandits.
- MCP/plugin integration.
- Broad scheduling, calendar, music, or life-assistant expansion.

## Setup risks

- macOS Automation permission is required for System Events and scriptable-browser observation/control.
- Accessibility permission is required for Firefox/Zen title observation and keyboard-driven tab closing.
- Electron notifications must be enabled in macOS System Settings for visible nudges.
- The unsigned app may require right-click → **Open** on first launch.
- The desktop README requires Node.js 20+. This documentation task was verified with Node.js `v26.7.0`; the server declares Node.js 18 or newer.
- No dependency lockfile, `.nvmrc`, or `.node-version` is present as of the reviewed baseline. Install results can therefore vary across machines and Node versions.
- Local development can read `GROQ_API_KEY` and optional `GROQ_MODEL` from the ignored root `.env`; shell variables take precedence. The default model is `openai/gpt-oss-20b`.
- Calling requires a reachable server plus provider-specific credentials and account verification. Sleeping deployments can miss scheduled calls.
