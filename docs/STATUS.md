# Concentr8 status

This file records fast-changing implementation status. Keep durable product and workflow rules in [`../AGENTS.md`](../AGENTS.md).

## Current main

- Code baseline reviewed for this documentation-only update: `3901208` (`origin/main` on 2026-10-24).
- No application, server, provider, test, or architecture behavior is changed by this documentation update.
- Use `git log -1 --oneline` to identify the documentation commit layered on this baseline.

## Proven working

Supported by current code, automated checks, and the manual verification completed before this documentation pass:

- Sessions start from arbitrary typed intents, including intents that do not match bCourses.
- Foreground Mac application monitoring through AppleScript/`osascript`.
- Active page-title capture for scriptable browsers.
- Complete active URL capture, including query parameters.
- `ActivityContext` carries both the observed activity and active intent to classification.
- Direct bCourses sync and calendar-feed fallback.
- Visible warning, grace period, and redirect/restore behavior for configured distractions.
- Intentional breaks pause interventions and can be ended to resume monitoring.
- The in-session intervention log is visible, and ended-session summaries are stored locally.
- The call-server client/API and Telnyx/Twilio provider implementations are present on main.
- Optional ElevenLabs voice through Telnyx and optional Claude phone-response handling are present on the server.

Real provider calls still depend on valid credentials, account state, phone verification, and a reachable deployment. Their presence in main is not a claim that every provider account is currently ready.

Documentation-task verification on Node.js `v26.7.0`:

- `npm run typecheck`: passed.
- `npm test`: passed, 16/16 tests.
- `npm run build`: passed.

## Current known limitations

- Semantic task relevance is not solved.
- The classifier receives the intent, but deterministic logic largely ignores semantic relevance.
- Generic productive domains and apps can be falsely labeled focus.
- An unrelated NFL search during Math homework may be neutral rather than explicitly recognized as off-task.
- GitHub and other generally useful domains should not remain universally on-task without task context.
- `STUCK` and `RECOVERING` are not yet fully first-class product states in the current implementation.
- Observation and intervention are macOS-specific; other platforms use a no-op observer.
- macOS permissions and provider/deployment setup can affect demo reliability.

## Current product direction

Planning guidance, not an immutable roadmap:

1. Conservative, task-aware deterministic relevance.
2. Semantic/Claude classification only for genuinely ambiguous activity.
3. User correction such as “This is actually work.”
4. Explicit recovery episodes and metrics.
5. An “I'm stuck” recovery flow.
6. A richer intervention ladder if time remains.

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
- Calling requires a reachable server plus provider-specific credentials and account verification. Sleeping deployments can miss scheduled calls.
