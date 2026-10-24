# Concentr8 operating guide

If you are a new human or coding agent:

1. Read README.md.
2. Read AGENTS.md completely.
3. Read docs/STATUS.md.
4. Read subsystem-specific docs only if working there.
5. Fetch origin/main before editing.
6. Confirm your owned task/subsystem before making changes.

## Product thesis

Concentr8 is not just a blocker. It is an execution-recovery agent that helps someone follow through on a chosen intention.

The intended loop is:

```text
intent
→ observe behavior
→ classify execution state
→ intervene only when useful
→ help restore/recover
→ verify whether recovery happened
```

The initial target is Berkeley students with ADHD or executive-function challenges. Describe support for focus, follow-through, and recovery; do not make medical or treatment claims.

## Current architecture

- Electron desktop app.
- TypeScript main process under `src/`.
- Plain HTML/CSS/JavaScript renderer under `renderer/`.
- AppleScript/`osascript` for macOS foreground-app and browser observation/control.
- Local JSON persistence in Electron's `userData` directory.
- Electron `safeStorage` for bCourses and call-server secrets.
- Direct bCourses/Canvas integration with a calendar-feed fallback.
- Deterministic local classifier and focus engine.
- Provider-agnostic semantic classifier for otherwise-neutral activity, with optional Claude (preferred when configured) and Groq providers.
- Node call server under `server/`.
- Telnyx or Twilio calling providers.
- Optional ElevenLabs voice through Telnyx.
- Optional Claude use on the server for more natural phone responses.

The current architecture does **not** include React, a Chrome extension, screenshots, reinforcement learning/contextual bandits, an MCP dependency, production authentication, or a cross-platform guarantee.

## Current product invariants

Preserve these unless a demonstrated problem and an approved milestone require changing them:

- Working macOS observer.
- Sessions from arbitrary typed intents.
- Optional bCourses integration.
- Warning → grace → redirect/restore loop.
- Intentional-break behavior.
- Local-first state and history.
- Current Electron architecture.

Do not rewrite working components for architectural purity during the hackathon.

## Classification philosophy

- `ActivityContext` contains the observed `activity` and current `intent`.
- Scriptable-browser activity includes the page title and complete URL, including its query string.
- The deterministic classifier still relies mostly on domain and app rules.
- Deterministic focus and distraction verdicts never call a model.
- Neutral activity may use a session-local cached semantic provider when configured.
- Semantic results become focus/distraction only at confidence `0.85` or higher; failures, uncertainty, and lower confidence remain neutral.
- An NFL Google search during Math homework should not be on-task.
- GitHub should not be universally on-task merely because its domain is often useful.
- Prefer conservative `neutral` over confidently wrong classification.
- Keep semantic providers replaceable; do not couple the focus engine to Groq, Claude, Gemini, OpenRouter, or a local model.

## Product principles

- Reliable demo over broad feature count.
- One bounded milestone at a time.
- Preserve intentional breaks.
- Context matters; avoid treating every domain as permanently good or bad.
- Interventions should be understandable and non-punitive.
- Keep data local when possible.
- Use deterministic logic before LLM calls.
- Make small, reviewable diffs.
- Run tests before declaring work complete.

## Team workflow

1. Run `git status --short --branch` and `git fetch origin` before starting.
2. Verify the work is based on current `origin/main`; never overwrite divergent or uncommitted work.
3. Confirm ownership before editing an overlapping subsystem.
4. Never force-push.
5. Never use `git reset --hard` to overwrite teammate work.
6. Prefer one bounded feature per commit and push.
7. Run typecheck, tests, and build when relevant.
8. Manually verify user-visible behavior changes.
9. Update `AGENTS.md` or `docs/STATUS.md` when architecture, ownership, or product direction materially changes.

## Ownership

- Desktop, focus, relevance, and recovery work form one workstream.
- Calling, Telnyx, Twilio, ElevenLabs, and `server/` form the partner-owned workstream.
- A new teammate must receive a bounded subsystem or task before editing overlapping files.

Do not modify `server/` from the desktop/recovery workstream without coordination. Do not invent teammate names or assume ownership from commit authorship alone.

## Scope guardrails

Do not start these unless explicitly approved:

- React rewrite.
- Chrome-extension rewrite.
- Screenshot-everything architecture.
- Reinforcement learning or contextual bandits.
- MCP/plugin work.
- Broad calendar, music, or life-assistant features.
- Production authentication.
- Multi-platform rewrite.

## Verification expectations

When appropriate for the files changed, run:

```sh
npm run typecheck
npm test
npm run build
```

Automated checks do not replace manual verification of user-visible flows, macOS permissions, browser observation, notifications, redirect/restore behavior, breaks, or live provider calls.

## Subsystem references

- Current verified state and planning guidance: [`docs/STATUS.md`](docs/STATUS.md)
- Call-server deployment and secrets: [`server/README.md`](server/README.md)
- Desktop/call-server contract: [`docs/call-server-api.md`](docs/call-server-api.md)
