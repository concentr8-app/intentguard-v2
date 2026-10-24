# Concentr8 status

This file records fast-changing implementation status. Keep durable product and workflow rules in [`../AGENTS.md`](../AGENTS.md).

## Current main

- Code baseline for the local development secret-loading milestone: `668244a` (`origin/main` on 2026-10-24).
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
- Otherwise-neutral activity can optionally use Claude or Groq through a provider-independent interface. Claude is preferred when `ANTHROPIC_API_KEY` is set; `SEMANTIC_PROVIDER` overrides the choice. Both providers share one prompt, schema, and validator.
- The Claude provider is covered by automated tests with a fake Messages API (request shape, URL-parameter minimization, refusal/truncation/error fallbacks). A live call with a real key has not been recorded here yet.
- Semantic results use a `0.85` confidence threshold; uncertainty, low confidence, missing configuration, and API failures remain neutral.
- Semantic classifications are cached by intent plus activity for the current session, preventing repeated calls from unchanged three-second polls.
- Unpackaged Electron development loads an ignored root `.env` without overriding existing shell variables.
- Direct bCourses sync and calendar-feed fallback.
- Visible warning, grace period, and redirect/restore behavior for configured distractions.
- Intentional breaks pause interventions and can be ended to resume monitoring.
- The in-session intervention log is visible, and ended-session summaries are stored locally.
- The call-server client/API and Telnyx/Twilio provider implementations are present on main.
- Optional ElevenLabs voice through Telnyx and optional Claude phone-response handling are present on the server.

Real provider calls still depend on valid credentials, account state, phone verification, and a reachable deployment. Their presence in main is not a claim that every provider account is currently ready.

Latest automated verification on Node.js `v26.7.0`:

- `npm run typecheck`: passed.
- `npm test`: passed, 28/28 tests.
- `npm run build`: passed.

## Current known limitations

- Semantic classification requires an optional provider key and network connection; the app remains deterministic without them.
- Ambiguous activity intentionally remains neutral and is not blocked.
- Explicit deterministic distractions never reach semantic classification, even if a page title could be educational.
- The semantic cache is in-memory and session-local; there is no long-term AI memory.
- An unrelated NFL search during Math homework is neutral rather than assumed on-task or blocked.
- `STUCK` and `RECOVERING` are not yet fully first-class product states in the current implementation.
- Observation and intervention are macOS-specific; other platforms use a no-op observer.
- macOS permissions and provider/deployment setup can affect demo reliability.

## Current product direction

Planning guidance, not an immutable roadmap:

Completed: conservative, task-aware deterministic relevance.

Completed: provider-agnostic semantic classification for neutral activity, with optional Claude and Groq support.

1. User correction such as “This is actually work.”
2. Explicit recovery episodes and metrics.
3. An “I'm stuck” recovery flow.
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
- Local development can read `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, optional `ANTHROPIC_MODEL`/`GROQ_MODEL`, and optional `SEMANTIC_PROVIDER` from the ignored root `.env`; shell variables take precedence. Default models are `claude-haiku-5-5` and `openai/gpt-oss-20b`.
- Calling requires a reachable server plus provider-specific credentials and account verification. Sleeping deployments can miss scheduled calls.
