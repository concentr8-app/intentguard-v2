# Concentr8 call server

Phones you every morning, reads your next Canvas deadlines, asks which one you'll start and when,
and gives the answer to the Mac app. No dependencies, Node 18 or newer.

One server can phone many students: each signs up in the app with an invite code and gets their own token.

This is the reference version. If the server Replit Agent built works, use that one;
if not, run this folder on Replit instead (it follows the same API, see `../docs/call-server-api.md`).

## Run it on Replit

1. Import the GitHub repo into Replit, or copy this `server/` folder into a Node Repl.
2. Add these Secrets. Pick **one** way to phone people. Cartesia (a voice agent, most natural) is used first when its secrets are set, then Telnyx, then Twilio:

   **Cartesia** (setup: [`../docs/CARTESIA-SETUP.md`](../docs/CARTESIA-SETUP.md)).

   | Name | Value |
   |---|---|
   | `CARTESIA_API_KEY` | Cartesia Playground → API Keys |
   | `CARTESIA_AGENT_ID` | your agent's ID |
   | `CARTESIA_PHONE_NUMBER_ID` | the ID of your Cartesia phone number |
   | `CARTESIA_WEBHOOK_SECRET` | any long random string; also the Bearer token of the agent's `save_plan` tool |
   | `CARTESIA_STUCK_AGENT_ID` | optional: the stuck-call agent (`docs/CARTESIA-SETUP.md`, step 6). Turns on "Talk it through on the phone" in the app |

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
   | `APP_API_KEY` | any long password: the **owner's** key (your own app uses it) |
   | `REGISTER_CODE` | the invite code friends type in the app to sign up. Without it nobody can sign up |
   | `RECOVERY_CODE` | a separate long code the team can give a student whose Mac lost its token. In open-signup mode it is required before an existing phone number receives a replacement token |
   | `ANTHROPIC_API_KEY` | optional but recommended: Claude writes the first step when a student presses "I'm stuck" (the downloaded Mac app ships no key and asks the server), and makes the scripted Telnyx/Twilio call sound less scripted |
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
| `MAX_SIGNUPS_PER_DAY` | `200` | new students per day |
| `PUBLIC_URL` | auto on Replit | base URL Twilio calls back |
| `DATA_FILE` | `server/data.json` | where tasks and answers are kept |
| `CALL_VOICE` | `Polly.Joanna-Neural` | the `<Say>` voice. Telnyx + ElevenLabs: `ElevenLabs.Default.<voice_id>` |
| `TELNYX_VOICE_KEY_REF` | none | Telnyx integration-secret name holding your ElevenLabs key (needs a paid ElevenLabs plan) |
| `TWILIO_VOICE` | | old name of `CALL_VOICE` |
| `VALIDATE_TWILIO_SIGNATURE` | off | set `true` to reject webhooks not signed by Twilio |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | model for first steps and the optional natural replies |

## Many students

- Share the app and the invite code (`REGISTER_CODE`). In the app: **Settings → Morning call**, phone, invite code, tick the box, **Start my morning calls**.
- Every student has their own phone, call time, timezone and tasks. The server calls each at their own local time.
- Students can say “stop” on the call, or delete their account in the app (`DELETE /api/me`).
- Only your own bCourses can be read by the server (`CANVAS_TOKEN`). Everyone else's app pushes their tasks when it syncs.
- A Telnyx trial account calls only its verified numbers and 10 calls a day. For real use you need a paid carrier plan (or a carrier whose numbers can call anyone).
- Calling people needs their consent (in the US this is covered by the TCPA). The app asks for it when they sign up; keep the invite code among people who agreed.

## Tests

```sh
cd server && npm test
```

## Test without a phone

```sh
APP_API_KEY=test node index.js
curl -X POST localhost:3000/twilio/voice                      # what the call says first
curl -X POST "localhost:3000/twilio/gather?step=task&try=0" --data-urlencode "SpeechResult=the CS 188 project"
curl -X POST "localhost:3000/twilio/gather?step=time&try=0" --data-urlencode "SpeechResult=9:30 a.m."
curl -H "Authorization: Bearer test" localhost:3000/api/today
```

## Who may sign up

`OPEN_SIGNUPS=true`: anyone, no code. `REGISTER_CODE=<word>`: only people with the code. Neither: closed.
Open mode has no phone verification yet: someone could enter a stranger's number and the server would call it (the daily caps limit the damage). An existing number receives HTTP 409 unless the student enters the operator-provided `RECOVERY_CODE`; successful recovery replaces the old token.
