# Concentr8 call server

Phones you every morning, reads your next Canvas deadlines, asks which one you'll start and when,
and gives the answer to the Mac app. No dependencies, Node 18 or newer.

This is the reference version. If the server Replit Agent built works, use that one;
if not, run this folder on Replit instead (it follows the same API, see `../docs/call-server-api.md`).

## Run it on Replit

1. Import the GitHub repo into Replit, or copy this `server/` folder into a Node Repl.
2. Add these Secrets. Pick **one** phone carrier:

   **Telnyx** (used when `TELNYX_API_KEY` is set). New accounts can call their verified number right away.

   | Name | Value |
   |---|---|
   | `TELNYX_API_KEY` | Telnyx portal → API keys |
   | `TELNYX_ACCOUNT_SID` | your Telnyx account ID (UUID) |
   | `TELNYX_APP_ID` | ID of your TeXML Application (its Voice URL: `https://<your-url>/twilio/voice`, POST) |
   | `TELNYX_PHONE_NUMBER` | your Telnyx number, like `+15105550123` |

   **Twilio.** Since late 2025, calls to +1 numbers need an approved *Business* customer profile (error 21216 otherwise).

   | Name | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | starts with `AC`, from the Twilio console |
   | `TWILIO_AUTH_TOKEN` | from the Twilio console |
   | `TWILIO_PHONE_NUMBER` | your Twilio number |

   Both:

   | Name | Value |
   |---|---|
   | `USER_PHONE_NUMBER` | the phone to call (on trial accounts it must be your verified number) |
   | `APP_API_KEY` | any long password; the Mac app needs the same one |
   | `ANTHROPIC_API_KEY` | optional: Claude makes the call sound less scripted |
   | `CANVAS_TOKEN` | optional: bCourses access token, so the call reads your deadlines even when the Mac app is closed |
   | `CANVAS_FEED_URL` | optional, instead of the token: the bCourses calendar feed link |
   | `PUBLIC_URL` | recommended after publishing: your deployment URL, e.g. `https://concentr8.replit.app` |

3. Run command: `cd server && npm start`.
4. Deploy it as something that keeps running (the 8:00 call needs the process awake).
   If your deployment sleeps, add a free external cron job that opens
   `https://<your-url>/cron/morning?key=<APP_API_KEY>` at 8:00 every day.

The server finds its own public address on Replit. Elsewhere, set `PUBLIC_URL`.

## Other settings

| Name | Default | What it does |
|---|---|---|
| `PORT` | `3000` | |
| `PUBLIC_URL` | auto on Replit | base URL Twilio calls back |
| `DATA_FILE` | `server/data.json` | where tasks and answers are kept |
| `TWILIO_VOICE` | `Polly.Joanna-Neural` | any Twilio `<Say>` voice |
| `VALIDATE_TWILIO_SIGNATURE` | off | set `true` to reject webhooks not signed by Twilio |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | model for the optional natural replies |

## Test without a phone

```sh
APP_API_KEY=test node index.js
curl -X POST localhost:3000/twilio/voice                      # what the call says first
curl -X POST "localhost:3000/twilio/gather?step=task&try=0" --data-urlencode "SpeechResult=the CS 188 project"
curl -X POST "localhost:3000/twilio/gather?step=time&try=0" --data-urlencode "SpeechResult=9:30 a.m."
curl -H "Authorization: Bearer test" localhost:3000/api/today
```
