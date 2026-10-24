# Call server API

The contract between the Mac app (`src/services/callServer.ts`) and the call server
(`server/index.js`, or whatever Replit builds). Keep both sides in sync.

One server serves many students. Every student has their own phone number, call time, tasks and token.
All `/api/*` routes except `/api/health` and `/api/register` need `Authorization: Bearer <token>`:
the student's own token (from `/api/register`), or `APP_API_KEY` for the server's owner. JSON in and out.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ "ok": true, "provider": "telnyx", "users": 3, "signupsOpen": true, … }` (no secrets, no phone numbers) |
| POST | `/api/register` | `{ "phoneNumber", "inviteCode", "consent": true, "callTime"?, "timezone"? }` | `{ "ok": true, "userId", "token" }`. Needs `REGISTER_CODE` on the server; signing up again with the same number issues a new token |
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

## Twilio webhooks (public)

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
