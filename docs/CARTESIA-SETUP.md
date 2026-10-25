# Morning call with a Cartesia voice agent

A Cartesia agent does the talking (natural voice, handles "um" and interruptions). Our server only
starts the call and saves the answer. Telnyx/Twilio stay as a fallback: if the Cartesia secrets are
missing, the server uses them.

```
server ──POST /agents/calls (student id + opening line)──▶ Cartesia ──phone──▶ student
server ◀──POST /cartesia/save-plan (task, start time)──── agent tool ◀─ what the student said
```

Cartesia numbers are US numbers and can only call US destinations
([source](https://docs.cartesia.ai/line/integrations/telephony/cartesia-numbers)).
The Startup plan (promo code `CARTESIACALHACKS` at Cal Hacks) includes voice-agent dollars; calls cost per minute.

## 1. Phone number

Playground → **Phone Numbers** → **Add Number** → **Cartesia Number**. Open the number and copy its **ID**
(that is `CARTESIA_PHONE_NUMBER_ID`, looks like `ap_…`). If you cannot find it, set `CARTESIA_API_KEY` on the
server first and open `https://<server>/api/cartesia/numbers?key=<APP_API_KEY>`.

## 2. Agent

Playground → **Agents** → new agent (start from a template, then replace the text). Names below are from the
[agent configuration docs](https://docs.cartesia.ai/agents/configuration); the buttons may be labeled a little differently.

**Voice:** pick a calm, friendly voice from the Voice Library. **Language:** English (`en`).

**Welcome message** (this is the whole greeting; the server fills it with the student's deadlines):

```
{{opening_line}}
```

**Instructions:**

```
You are Concentr8, a calm, friendly morning check-in on the phone for a Berkeley student who finds it hard to get started on tasks. Keep every sentence short and warm. Never lecture. The whole call takes under a minute.

Goal: find out (1) which ONE task they will start first and (2) at what time. Then save it with the save_plan tool.

How the call goes:
1. The welcome message already read their upcoming deadlines and asked which one they will start with. Listen.
2. If they pick one of those, or name anything else (homework, studying, a project), accept it. If it is unclear, ask once: "Which one do you want to start with?"
3. Ask: "When will you start? You can say a time, or now."
4. Call save_plan with task (a short name of what they chose; use the exact title from the deadlines when it clearly matches) and start_time (exactly what they said, like "9:30 a.m." or "now").
5. Confirm in one short sentence, for example "Locked in: the CS 188 project at nine thirty." Wish them luck and end the call.

Rules:
- If they say they do not want calls ("stop calling me", "unsubscribe"), call save_plan with stop_calls set to true, say you will not call again and that they can turn it back on in the Concentr8 app, then end the call.
- If they cannot decide, suggest the task that is due soonest, then ask when.
- Do not give medical advice and do not ask personal questions. If asked about anything else, say you only help with starting the day.
```

**Tools → End call:** turn on.

**Sample variables (for the Playground test call only):** `opening_line` = `Good morning, this is Concentr8. You have one thing coming up. Project 2 for CompSci 188, due tomorrow. Which one will you start with?` and `user_id` = `owner`.

## 3. The save_plan tool

Tools → add a **Webhook** tool ([docs](https://docs.cartesia.ai/agents/webhook-tools)):

| Field | Value |
|---|---|
| Name | `save_plan` |
| Description | Save the student's chosen task and start time, or turn off their morning calls. Call it once the student told you both. |
| Method / URL | `POST` `https://<your-server>/cartesia/save-plan` (HTTPS) |
| Authentication | Bearer, token = the value you will set as `CARTESIA_WEBHOOK_SECRET` (any long random string) |
| Body `user_id` (string) | source: **dynamic variable** `user_id` (never filled in by the model) |
| Body `task` (string) | source: model. Description: Short name of the task the student will start first. |
| Body `start_time` (string) | source: model. Description: When they will start, exactly as they said it, e.g. "9:30 a.m." or "now". |
| Body `stop_calls` (boolean) | source: model. Description: true only if the student asks not to be called anymore. |

Nothing is required in the schema; the server answers with a message that tells the agent what is missing.
Attach the tool to the agent, then **Publish** the agent.

## 4. Server secrets

On the server (Replit → Secrets):

| Name | Value |
|---|---|
| `CARTESIA_API_KEY` | Playground → API Keys |
| `CARTESIA_AGENT_ID` | the agent's ID |
| `CARTESIA_PHONE_NUMBER_ID` | from step 1 |
| `CARTESIA_WEBHOOK_SECRET` | the same string as the tool's bearer token |

Republish, then open `/api/health`: `"provider":"cartesia"` and all four `cartesia…` fields `true`.

## 5. Test

1. Playground test call with the sample variables (the tool saves a plan for the user `owner`).
2. In the app: **Call me now**. The phone rings, say a task and a time, the plan appears in the app.
3. If nothing is saved: Playground → Calls shows what the agent heard and whether the tool failed (a wrong secret, 401, is the usual reason).

## 6. The stuck-call agent

When a student presses **I'm stuck** and then **Talk it through on the phone**, a second agent calls them. It is a
separate agent, so the morning agent stays exactly as it is. The app shows the phone button only after
`CARTESIA_STUCK_AGENT_ID` is set on the server.

**Agents → Create New**, name it `concentr8-stuck`. Same calm voice as the morning agent, **Language:** English (`en`).

**Welcome message:**

```
{{opening_line}}
```

(The server fills it, for example: "Hi, it's Concentr8. You pressed I'm stuck on Project 2. That's okay, it happens to
everyone. There's no pressure, we'll just find one tiny first step together. What feels hardest about starting right now?")

**Instructions:**

```
You are Concentr8, a warm, calm voice on the phone. The student just pressed "I'm stuck" on {{task}} and asked for this call. They are a Berkeley student who finds it hard to get started, and right now they feel stuck or overwhelmed. You are someone who cares. Speak slowly, keep every sentence short, never lecture, never judge.

Goal: together, find ONE tiny first step they can do in the next 5 minutes, then save it with the save_step tool. The whole call takes about two minutes.

How the call goes:
1. The welcome message already asked what feels hardest. Listen. Reflect it back in one short sentence, for example "So the hard part is not knowing where to begin."
2. Suggest one step so small it feels almost too easy: open the file, read only the first question, write one messy sentence, list three words. It takes 5 minutes or less and happens on their computer right now. If they want something different, take their idea and make it smaller.
3. Ask: "Could you do just that for five minutes?" If they say no, make it smaller and ask again.
4. When they agree, call save_step with first_step: the step in a few words, starting with a verb, under 15 words.
5. Read it back in one warm sentence, say the app now shows it with a 5-minute timer, and end the call.

Rules:
- Only one step. No plans, no schedules, no to-do lists.
- If they want to stop or take a break, that is fine: say so kindly, do not call the tool, and end the call.
- Do not give medical advice. If they sound in crisis or mention hurting themselves, stop talking about the task, tell them they deserve support right now, and suggest they call or text 988 (Suicide & Crisis Lifeline, US) or reach out to someone they trust.
- If asked about anything else, say you are only here to help with the first step.
```

**Tools → add a Webhook tool** `save_step` and turn on **End call**:

| Field | Value |
|---|---|
| Name | `save_step` |
| Description | Save the one tiny first step the student agreed to do in the next 5 minutes. Call it once, after they said yes. |
| Method / URL | `POST` `https://<your-server>/cartesia/save-plan` (the same URL as `save_plan`) |
| Authentication | Bearer, the same `CARTESIA_WEBHOOK_SECRET` |
| Body `user_id` (string) | source: **dynamic variable** `user_id` |
| Body `first_step` (string) | source: model. Description: The tiny first step, starting with a verb, e.g. "Open the spec and read only Question 1". |

**Sample variables** (Playground test call): `opening_line` = the example above, `task` = `Project 2 for CompSci 188`,
`user_id` = the id of a signed-up student (the test user `owner` exists only if the owner key was used).

**Publish**, copy the agent's **ID**, and set it on the server as `CARTESIA_STUCK_AGENT_ID` (Azure → Environment
variables), then restart. `/api/health` now shows `"features":["stuck-call"]`.

**Try it:** in the app start a session, press **I'm stuck**, end the calm screen, then **Talk it through on the phone**.
After the call the step from the phone replaces the prepared one.
