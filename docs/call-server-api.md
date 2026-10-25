# Call server API

The contract between the Mac app (`src/services/callServer.ts`) and the call server
(`server/index.js`, or whatever Replit builds). Keep both sides in sync.

One server serves many students. Every student has their own phone number, call time, tasks and token.
All `/api/*` routes except `/api/health` and `/api/register` need `Authorization: Bearer <token>`:
the student's own token (from `/api/register`), or `APP_API_KEY` for the server's owner. JSON in and out.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ "ok": true, "provider": "telnyx", "users": 3, "signupsOpen": true, … }` (no secrets, no phone numbers) |
| POST | `/api/register` | `{ "phoneNumber", "inviteCode", "consent": true, "callTime"?, "timezone"? }` | `{ "ok": true, "userId", "token" }`. In invite mode, needs `REGISTER_CODE`. In open-signup mode, an existing number needs `RECOVERY_CODE`; recovery replaces the old token |
| GET | `/api/me` | | `{ "id", "phoneNumber", "callTime", "timezone", "paused" }` |
| DELETE | `/api/me` | | `{ "ok": true }` removes the student and their data |
| POST | `/api/tasks` | `{ "tasks": [{ "id", "title", "course", "dueAt", "url" }] }` | `{ "ok": true, "count": 2 }` (replaces the stored list) |
| GET | `/api/today` | | `{ "date": "2026-10-24", "focusTask": "the CS 188 project", "startTime": "9:30 a.m.", "lastCallAt": "…", "lastCallStatus": "completed" }` |
| POST | `/api/call-now` | `{}` | `{ "ok": true, "callSid": "CA…" }` |
| POST | `/api/settings` | `{ "phoneNumber"?, "callTime"?: "08:00", "timezone"?: "America/Los_Angeles", "paused"?: false }` | `{ "ok": true }` |
| GET | `/cron/morning?key=<token>` | | same as call-now for that student |
| GET | `/cron/tick?key=<APP_API_KEY>` | | runs the scheduler once for everyone (for hosts that sleep: an external cron opens it every few minutes); `{ "ok": true, "called": 2 }` |

Limits: `MAX_CALLS_PER_USER_PER_DAY` (10), `MAX_CALLS_PER_DAY` (300), `MAX_SIGNUPS_PER_DAY` (200); over the limit the server answers `429`.
Saying "stop" on the phone sets `paused`: no automatic calls until the student asks for a call again.

`dueAt`, `lastCallAt`: ISO timestamps or `null`. `startTime` is what the student said, the Mac app parses it.

## The stuck call ("I'm stuck" → "Talk it through on the phone")

When a student presses **I'm stuck**, the Mac app shows a calm screen and then one tiny first step. If the server
announces `stuck-call`, the app also offers **Talk it through on the phone**: someone calls, listens, and agrees on
one tiny first step with them. Older servers announce nothing and keep working unchanged.

| Part | Detail |
|---|---|
| `GET /api/health` | `"features": ["stuck-call"]` once `CARTESIA_STUCK_AGENT_ID` is set (Cartesia only; `cartesiaStuckAgent` shows it) |
| `POST /api/call-now` | body `{ "reason": "stuck", "task": "CS 188 Project 2" }` calls with the **stuck agent** (dynamic variables `user_id`, `opening_line`, `task`). No body = the morning call, as before. A stuck call does not end a "stop" for morning calls. 400 if the server cannot place stuck calls |
| `POST /cartesia/save-plan` | the stuck agent's `save_step` tool sends `{ "user_id", "first_step" }`; the server stores it with the time it was saved |
| `GET /api/today` | `"firstStep"` and `"firstStepAt"` (ISO). The app polls this every 5 s during the call and uses a step only if `firstStepAt` is newer than before the call |

If no step arrives within 4 minutes, or the call fails, the app falls back to the step it already prepared.
Desktop side: `src/main/controller.ts` (`stuckCall`, `stepFromCall`) and `src/services/callServer.ts`.
Agent setup: [`CARTESIA-SETUP.md`](CARTESIA-SETUP.md#6-the-stuck-call-agent).

## Claude's first step

The downloaded Mac app ships no API key, so when a signed-in student presses **I'm stuck** it asks the server.

| Part | Detail |
|---|---|
| `GET /api/health` | `"features"` contains `"first-step"` when `ANTHROPIC_API_KEY` is set |
| `POST /api/first-step` | student token; body `{ "task", "course", "attempt", "previous_step" }` (no URLs) → `{ "step", "minutes" }` from Claude (`ANTHROPIC_MODEL`, structured output). 503 without a key, 429 over the daily caps (`MAX_STEPS_PER_USER_PER_DAY` 40, `MAX_STEPS_PER_DAY` 3000), 502 if Claude fails. The app falls back to fixed steps on any error |

## Cartesia agent tool

| Path | When |
|---|---|
| `POST /cartesia/save-plan` | the Cartesia agent saves the answer. `Authorization: Bearer <CARTESIA_WEBHOOK_SECRET>`, body `{ "user_id", "task", "start_time" }`, `{ "user_id", "stop_calls": true }` or `{ "user_id", "first_step" }` (stuck call). Answers a short plain-text message the agent reads. See `CARTESIA-SETUP.md` |
| `GET /api/cartesia/numbers` | owner only: lists your Cartesia phone numbers (to find `CARTESIA_PHONE_NUMBER_ID`) |

## Twilio / Telnyx webhooks (public, only used by the scripted fallback)

| Path | When |
|---|---|
| `POST /twilio/voice?u=<id>` | call answered: reads the top 3 tasks, asks which one. Without `u`, the caller's number identifies the student; unknown numbers hear "please sign up in the app" |
| `POST /twilio/gather?step=task` | answer saved as `focusTask`, asks when |
| `POST /twilio/gather?step=time` | answer saved as `startTime`, says goodbye |
| `POST /twilio/status` | call status updates, saved as `lastCallStatus` |

## Try it with curl

```sh
B=https://your-repl.replit.app; K=your-app-api-key
curl $B/api/health
curl -H "Authorization: Bearer $K" $B/api/today
curl -X POST -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -d '{"tasks":[{"id":"1","title":"Project 2","course":"COMPSCI 188","dueAt":null,"url":null}]}' $B/api/tasks
curl -X POST -H "Authorization: Bearer $K" $B/api/call-now
```
