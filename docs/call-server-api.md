# Call server API

The contract between the Mac app (`src/services/callServer.ts`) and the call server
(`server/index.js`, or whatever Replit builds). Keep both sides in sync.

All `/api/*` routes except `/api/health` need `Authorization: Bearer <APP_API_KEY>`. JSON in and out.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | | `{ "ok": true }` |
| POST | `/api/tasks` | `{ "tasks": [{ "id", "title", "course", "dueAt", "url" }] }` | `{ "ok": true, "count": 2 }` (replaces the stored list) |
| GET | `/api/today` | | `{ "date": "2026-10-24", "focusTask": "the CS 188 project", "startTime": "9:30 a.m.", "lastCallAt": "…", "lastCallStatus": "completed" }` |
| POST | `/api/call-now` | `{}` | `{ "ok": true, "callSid": "CA…" }` |
| POST | `/api/settings` | `{ "phoneNumber"?, "callTime"?: "08:00", "timezone"?: "America/Los_Angeles" }` | `{ "ok": true }` |
| GET | `/cron/morning?key=<APP_API_KEY>` | | same as call-now; backup trigger for an external cron service |

`dueAt`, `lastCallAt`: ISO timestamps or `null`. `startTime` is what the student said, the Mac app parses it.

## Twilio webhooks (public)

| Path | When |
|---|---|
| `POST /twilio/voice` | call answered: reads the top 3 tasks, asks which one |
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
