// Concentr8 Call Server — zero dependencies, Node 18+.
// Phones each student every morning (Telnyx or Twilio), asks which task they'll start and when,
// and hands the answer to their Mac app. Many students can use one server (see "users" below).
// API contract: ../docs/call-server-api.md
//
// Run:  node index.js        (env vars: see README.md in this folder)

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const DATA_FILE = env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_TZ = 'America/Los_Angeles';

// ---------- storage ----------

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Everything is kept per student in data.users[id]. The student who set APP_API_KEY (the server's
 * owner) is the user "owner"; everyone else signs up through POST /api/register and gets their own token.
 */
function newUser(id, fields = {}) {
  return {
    id,
    tokenHash: null,
    phoneNumber: null,
    callTime: '08:00',
    timezone: DEFAULT_TZ,
    tasks: [],
    today: { date: null, focusTask: null, startTime: null },
    lastCallAt: null,
    lastCallStatus: null,
    lastAutoCallDate: null,
    paused: false, // said "stop" on the phone: no more automatic calls until they ask for one
    consentAt: null,
    createdAt: new Date().toISOString(),
    calls: { date: null, count: 0 },
    ...fields,
  };
}

function migrate(raw) {
  const out = { users: raw.users || {}, publicBase: raw.publicBase || null, global: raw.global || { date: null, calls: 0, signups: 0 } };
  if (!raw.users && (raw.settings || raw.tasks)) {
    // The single-student format of the first version becomes the owner.
    out.users.owner = newUser('owner', {
      phoneNumber: (raw.settings && raw.settings.phoneNumber) || null,
      callTime: (raw.settings && raw.settings.callTime) || '08:00',
      timezone: (raw.settings && raw.settings.timezone) || DEFAULT_TZ,
      tasks: raw.tasks || [],
      today: raw.today || { date: null, focusTask: null, startTime: null },
      lastCallAt: raw.lastCallAt || null,
      lastCallStatus: raw.lastCallStatus || null,
      lastAutoCallDate: raw.lastAutoCallDate || null,
    });
  }
  return out;
}

const data = migrate(loadData());

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); // e.g. /home/data on Azure does not exist at first
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function owner() {
  if (!data.users.owner) data.users.owner = newUser('owner');
  return data.users.owner;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** "(415) 555-1234", "4155551234" or "+14155551234" -> "+14155551234"; null if it isn't a phone number. */
function normalizePhone(input) {
  const raw = String(input || '').replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(raw)) return `+1${raw}`;
  if (/^1\d{10}$/.test(raw)) return `+${raw}`;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  return null;
}

const validTimezone = (tzName) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzName });
    return true;
  } catch {
    return false;
  }
};

const phoneOf = (u) => u.phoneNumber || (u.id === 'owner' ? normalizePhone(env.USER_PHONE_NUMBER) : null);

const userByPhone = (phone) => {
  const p = normalizePhone(phone);
  return p ? Object.values(data.users).find((u) => phoneOf(u) === p) || null : null;
};

// ---------- time ----------

function zoned(date, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return parts;
}

const tzOf = (u) => u.timezone || DEFAULT_TZ;
const localDate = (u, d = new Date()) => {
  const p = zoned(d, tzOf(u));
  return `${p.year}-${p.month}-${p.day}`;
};
const localHHMM = (u, d = new Date()) => {
  const p = zoned(d, tzOf(u));
  return `${p.hour}:${p.minute}`;
};

/** Today's record, reset after midnight in the student's timezone. */
function today(u) {
  const date = localDate(u);
  if (u.today.date !== date) u.today = { date, focusTask: null, startTime: null };
  return u.today;
}

/** "due today", "due tomorrow", "due Monday" — for reading out loud. */
function spokenDue(u, iso) {
  if (!iso) return '';
  const due = new Date(iso);
  const now = new Date();
  if (due < now) return ', which is overdue';
  const dayMs = 86_400_000;
  if (localDate(u, due) === localDate(u, now)) return ', due today';
  if (localDate(u, due) === localDate(u, new Date(now.getTime() + dayMs))) return ', due tomorrow';
  if (due - now < 6 * dayMs) return `, due ${zoned(due, tzOf(u)).weekday}`;
  return '';
}

/** "COMPSCI 188" reads better as "CompSci 188"; strip section suffixes like " - LEC 001". */
function spokenCourse(course) {
  return String(course || '')
    .replace(/\s*-\s*(LEC|DIS|LAB|SEM)\b.*$/i, '')
    .replace(/\bCOMPSCI\b/i, 'CompSci')
    .trim();
}

// ---------- TwiML ----------

const xml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/**
 * Which service places the calls:
 *  - "cartesia": a Cartesia voice agent does the talking (docs/CARTESIA-SETUP.md). CARTESIA_API_KEY,
 *    CARTESIA_AGENT_ID, CARTESIA_PHONE_NUMBER_ID, CARTESIA_WEBHOOK_SECRET
 *  - "telnyx" / "twilio": our own scripted call. They speak (almost) the same XML:
 *    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER  |  TELNYX_API_KEY, TELNYX_ACCOUNT_SID, TELNYX_APP_ID, TELNYX_PHONE_NUMBER
 * Defaults to Cartesia when it is fully configured, else Telnyx when a Telnyx key is set.
 */
const cartesiaReady = () => !!(env.CARTESIA_API_KEY && env.CARTESIA_AGENT_ID && env.CARTESIA_PHONE_NUMBER_ID);
const PROVIDER = (env.CALL_PROVIDER || (cartesiaReady() ? 'cartesia' : env.TELNYX_API_KEY ? 'telnyx' : 'twilio')).toLowerCase();
/**
 * The stuck call ("I'm stuck" → "Talk it through on the phone") runs on its own Cartesia agent, so the morning
 * agent stays untouched. It is announced to the app only once CARTESIA_STUCK_AGENT_ID is set.
 */
const stuckCallReady = () => PROVIDER === 'cartesia' && cartesiaReady() && !!env.CARTESIA_STUCK_AGENT_ID;

const VOICE = env.CALL_VOICE || env.TWILIO_VOICE || 'Polly.Joanna-Neural';

function say(text) {
  const ref = env.TELNYX_VOICE_KEY_REF ? ` api_key_ref="${xml(env.TELNYX_VOICE_KEY_REF)}"` : '';
  return `<Say voice="${xml(VOICE)}"${ref}>${xml(text)}</Say>`;
}

function gather(u, step, attempt, prompt) {
  const hints = u.tasks
    .slice(0, 8)
    .flatMap((t) => [t.title, spokenCourse(t.course)])
    .filter(Boolean)
    .join(', ')
    .slice(0, 900);
  const action = `/twilio/gather?u=${u.id}&amp;step=${step}&amp;try=${attempt}`;
  // Twilio understands speechTimeout="auto"; Telnyx wants seconds.
  const speechTimeout = PROVIDER === 'telnyx' ? '2' : 'auto';
  return (
    `<Gather input="speech" action="${action}" timeout="6" speechTimeout="${speechTimeout}" language="en-US"` +
    (hints ? ` hints="${xml(hints)}"` : '') +
    `>${say(prompt)}</Gather>` +
    // Reached only if the student said nothing:
    `<Redirect>/twilio/gather?u=${u.id}&amp;step=${step}&amp;try=${attempt}&amp;empty=1</Redirect>`
  );
}

const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

/** Students pick their own call time (many are at their best in the evening), so the greeting follows the clock. */
function greetingFor(u, now = new Date()) {
  const hour = Number(zoned(now, tzOf(u)).hour);
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Hi' : 'Good evening';
}

function openingLine(u) {
  const greeting = greetingFor(u);
  const top = [...u.tasks]
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity))
    .slice(0, 3);
  if (top.length === 0) {
    return `${greeting}, this is Concentr8. What's the one thing you want to get done today?`;
  }
  const list = top.map((t) => `${t.title} for ${spokenCourse(t.course)}${spokenDue(u, t.dueAt)}`).join('. ');
  const count = top.length === 1 ? 'one thing' : `${['', 'one', 'two', 'three'][top.length]} things`;
  return `${greeting}, this is Concentr8. You have ${count} coming up. ${list}. Which one will you start with?`;
}

/**
 * Claude writes the call's greeting from the student's real deadlines. Any failure (no key, timeout, odd answer)
 * falls back to the fixed openingLine(u), so a call is never blocked by Claude.
 */
async function claudeOpeningLine(u) {
  const fallback = openingLine(u);
  if (!env.ANTHROPIC_API_KEY || u.tasks.length === 0) return fallback;
  const top = [...u.tasks]
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity))
    .slice(0, 4)
    .map((t) => `- ${t.title} for ${spokenCourse(t.course)}${spokenDue(u, t.dueAt)}`)
    .join('\n');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: claudeModel(),
        max_tokens: 150,
        system:
          'You write the first thing a voice assistant says on a planning phone call to a UC Berkeley student with ADHD, at the time they chose. ' +
          'Goal: help them pick ONE task and a start time. Rules: at most 3 short spoken sentences, warm and calm, no pressure, ' +
          'no guilt, no lists, no emojis, no markdown. Name at most two tasks, the most urgent first. ' +
          `Start with "${greetingFor(u)}, this is Concentr8." and end with a question asking which task they will start and when.`,
        messages: [{ role: 'user', content: `Their tasks, most urgent first:\n${top}` }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const why = await claudeError(res);
      console.error(`[greeting] ${why}; using the fixed greeting`);
      noteClaude('greeting', false, why);
      return fallback;
    }
    const body = await res.json();
    const text = String(body.content?.find((c) => c.type === 'text')?.text || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 20 && text.length <= 400 && text.endsWith('?')) {
      console.log('[greeting] written by Claude');
      noteClaude('greeting', true);
      return text;
    }
    console.error('[greeting] Claude answer did not fit; using the fixed greeting:', text.slice(0, 120));
    noteClaude('greeting', false, 'answer did not fit');
    return fallback;
  } catch (err) {
    console.error('[greeting] Claude request failed; using the fixed greeting:', err.name, err.message);
    noteClaude('greeting', false, err.name);
    return fallback;
  }
}

/** What the stuck agent says first. The calm screen already did the breathing; the call is about one tiny step. */
function stuckOpeningLine(task) {
  const what = task ? ` on ${task}` : '';
  return `Hi, it's Concentr8. You pressed I'm stuck${what}. That's okay, it happens to everyone. ` +
    "There's no pressure, we'll just find one tiny first step together. What feels hardest about starting right now?";
}

/** The task name the app sends for a stuck call: plain text, short enough to read out loud. */
const cleanTask = (task) => String(task || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/** "Um, I think I'll start with the CS project" -> "the CS project" */
function cleanAnswer(speech) {
  return String(speech || '')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/^(um+|uh+|okay|ok|so|well|yeah|hmm)[,\s]+/i, '')
    .replace(/^(i think\s+)?(i'?ll|i will|i'm going to|i am going to|i wanna|i want to|let'?s|probably)\s+(start\s+(with|on)\s+|do\s+|work on\s+)?/i, '')
    .trim();
}

// ---------- optional: Claude makes the reply sound natural ----------

async function claudeUnderstand(u, speech) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const tasks = u.tasks.slice(0, 10).map((t) => `- ${t.title} (${t.course})`).join('\n') || '(none)';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: claudeModel(),
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content:
              `A student with ADHD was asked on a morning phone call which task they will start with.\n` +
              `Their upcoming Canvas tasks:\n${tasks}\n\nThey said: "${speech}"\n\n` +
              `Reply with JSON only: {"task": "<short name of what they chose, use the exact Canvas title if it clearly matches>", ` +
              `"reply": "<one warm, short spoken sentence confirming it, then ask when they will start>"}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body.content?.find((c) => c.type === 'text')?.text || '';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (typeof json.task === 'string' && typeof json.reply === 'string') return json;
  } catch {
    // fall back to the fixed script
  }
  return null;
}

// ---------- is Claude working? ----------
// The last outcome of every Claude feature, shown (without any secret or student data) in /api/health, so a
// deployment can be checked from outside: is the key set, does Claude answer, and did each feature work last time.
const claudeStatus = { selfTest: null, greeting: null, firstStep: null, summary: null, relevance: null };
// The deploy workflow writes build.json with the commit, so a check after a deploy knows the new server is live.
const BUILD = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build.json'), 'utf8')).commit || null;
  } catch {
    return null;
  }
})();
const claudeModel = () => env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

function noteClaude(feature, ok, detail) {
  claudeStatus[feature] = { ok, at: new Date().toISOString(), ...(detail ? { detail: String(detail).slice(0, 160) } : {}) };
}

/** "Claude answered 400: Your credit balance is too low …": Anthropic's own error text, which holds no secret. */
async function claudeError(res) {
  const body = await res.json().catch(() => ({}));
  const message = String((body && body.error && body.error.message) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `Claude answered ${res.status}${message ? `: ${message}` : ''}`;
}

/** One tiny request (a few tokens) at start-up and twice a day: proves the key and the model work. */
async function claudeSelfTest() {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: claudeModel(), max_tokens: 5, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) noteClaude('selfTest', true);
    else {
      const why = await claudeError(res);
      noteClaude('selfTest', false, why);
      console.error(`[claude] self-test: ${why} (model ${claudeModel()})`);
    }
  } catch (err) {
    noteClaude('selfTest', false, err.name);
    console.error('[claude] self-test failed:', err.name, err.message);
  }
  return claudeStatus.selfTest;
}

// ---------- optional: Claude suggests the first step when a student presses "I'm stuck" ----------
// The Mac app cannot ship an API key, so a signed-in app asks the server. Only the task name, the course and the
// previous step leave the Mac; the app falls back to fixed steps on any error.

const MAX_STEPS_PER_USER_PER_DAY = Number(env.MAX_STEPS_PER_USER_PER_DAY || 40);
const MAX_STEPS_PER_DAY = Number(env.MAX_STEPS_PER_DAY || 3000);

const STEP_SYSTEM_PROMPT = [
  'You help a university student who feels stuck and cannot start a task.',
  'Reply with exactly one tiny, concrete first action they can do at their computer within the given minutes.',
  'Start with a verb. Under 25 words. No lists, no plans, no pep talk, no medical or therapy language.',
  'Only mention files, pages or details that are clearly implied by the task text; never invent links or file names.',
  'If the task is vague, suggest a step that makes it clearer.',
  'If this is a retry, make the action clearly smaller and easier than the previous one.',
].join(' ');


const oneLine = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

async function claudeFirstStep(body) {
  const task = oneLine(body.task, 300);
  if (!task) throw httpError(400, 'Missing task.');
  const attempt = Math.max(1, Math.min(10, Math.round(Number(body.attempt) || 1)));
  const lines = [`Task: ${task}`];
  const course = oneLine(body.course, 100);
  if (course) lines.push(`Course: ${course}`);
  lines.push('Minutes available: 5');
  const previous = oneLine(body.previous_step, 300);
  if (attempt > 1 && previous) lines.push(`Retry ${attempt}. This step was still too big: "${previous}"`);

  // A plain request with "JSON only" and a lenient parse. Structured outputs compile a grammar on first use, and
  // that extra latency must never push us past the app's 10 s timeout: the step is shown while the student waits.
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: claudeModel(),
        max_tokens: 200,
        system: `${STEP_SYSTEM_PROMPT} Reply with JSON only, no other text: {"step": "<the action>", "minutes": <2 to 10>}`,
        messages: [{ role: 'user', content: lines.join('\n') }],
      }),
      signal: AbortSignal.timeout(8500),
    });
  } catch (err) {
    console.error('[first-step] Claude request failed:', err.name, err.message);
    noteClaude('firstStep', false, err.name);
    throw httpError(502, `Claude did not answer (${err.name})`);
  }
  if (!res.ok) {
    const why = await claudeError(res);
    console.error(`[first-step] ${why}`);
    noteClaude('firstStep', false, why);
    throw httpError(502, `Claude answered ${res.status}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') {
    console.error('[first-step] Claude stopped early:', data.stop_reason);
    noteClaude('firstStep', false, `stopped early (${data.stop_reason})`);
    throw httpError(502, `Claude stopped early (${data.stop_reason})`);
  }
  const text = String((data.content || []).find((c) => c.type === 'text')?.text || '');
  let value;
  try {
    value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    console.error('[first-step] Claude did not answer with JSON:', text.slice(0, 200));
    noteClaude('firstStep', false, 'no JSON');
    throw httpError(502, 'Claude did not answer with a step');
  }
  const step = oneLine(value.step, 1000);
  if (!step || step.length > 240) {
    noteClaude('firstStep', false, 'no usable step');
    throw httpError(502, 'Claude did not answer with a usable step');
  }
  const minutes = Math.min(10, Math.max(2, Math.round(Number(value.minutes) || 5)));
  noteClaude('firstStep', true);
  return { step, minutes };
}

// ---------- Claude checks a page the app cannot judge on its own ----------
// During a focus session the app decides most pages itself (known distractions, course pages). For a page it cannot
// judge, it sends only the intent, the app name, the page title and host/path/search query; nothing is stored here.

const RELEVANCE_SYSTEM_PROMPT = [
  'A university student started a focus session to work on one task. Decide whether the activity on their computer helps with exactly that task.',
  'Be strict. relevant only when the activity clearly helps with this task: its course page, its instructions, material, research or tools it needs.',
  'Everything else is unrelated: sports, entertainment, social media, shopping, games, news, other courses and generally useful sites that do not serve this task. A search counts by what was searched for.',
  'Use the task background: something that looks off-topic is relevant when the task explains it, for example NFL statistics for a sports data project.',
  'uncertain only when the title and address say almost nothing, like a blank page, a login page or a bare home page.',
  'confidence is how sure you are, from 0 to 1. reason: under 15 words, addressed to the student, kind and without blame.',
  'Reply with JSON only, no other text: {"relevance": "relevant" | "unrelated" | "uncertain", "confidence": <0 to 1>, "reason": "<short>"}',
].join(' ');

async function claudeRelevance(body) {
  const intent = oneLine(body.intent, 300);
  if (!intent) throw httpError(400, 'Missing intent.');
  const task = body.task && typeof body.task === 'object' ? body.task : null;
  const lines = [
    `Intent: ${intent}`,
    ...(task
      ? [
          'Task background:',
          `- Title: ${oneLine(task.title, 200)}`,
          `- Course: ${oneLine(task.course, 100)}`,
          `- Kind: ${oneLine(task.kind, 30)}`,
          ...(task.dueAt ? [`- Due: ${oneLine(task.dueAt, 40)}`] : []),
          ...(task.description ? [`- Instructions: ${oneLine(task.description, 800)}`] : []),
        ]
      : []),
    'Activity:',
    `App: ${oneLine(body.app, 100) || '(unknown)'}`,
    `Title: ${oneLine(body.title, 300) || '(none)'}`,
    `Location: ${oneLine(body.location, 500) || '(none)'}`,
  ];
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: claudeModel(), max_tokens: 160, system: RELEVANCE_SYSTEM_PROMPT, messages: [{ role: 'user', content: lines.join('\n') }] }),
      signal: AbortSignal.timeout(7000),
    });
  } catch (err) {
    noteClaude('relevance', false, err.name);
    throw httpError(502, `Claude did not answer (${err.name})`);
  }
  if (!res.ok) {
    const why = await claudeError(res);
    console.error(`[relevance] ${why}`);
    noteClaude('relevance', false, why);
    throw httpError(502, why);
  }
  const data = await res.json();
  const text = String((data.content || []).find((c) => c.type === 'text')?.text || '');
  let value;
  try {
    value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    noteClaude('relevance', false, 'no JSON');
    throw httpError(502, 'Claude did not answer with JSON');
  }
  const relevance = ['relevant', 'unrelated', 'uncertain'].includes(value.relevance) ? value.relevance : null;
  const confidence = Number(value.confidence);
  if (!relevance || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    noteClaude('relevance', false, 'answer did not fit');
    throw httpError(502, 'Claude did not answer with a usable result');
  }
  noteClaude('relevance', true);
  return { relevance, confidence, reason: oneLine(value.reason, 160) };
}

// ---------- optional: read Canvas directly, so the call works even when the Mac is off ----------
// Set CANVAS_TOKEN (bCourses access token) or CANVAS_FEED_URL (bCourses calendar feed link).

function nextLink(header) {
  for (const part of String(header || '').split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

async function canvasFromApi() {
  const base = (env.CANVAS_BASE_URL || 'https://bcourses.berkeley.edu').replace(/\/+$/, '');
  const now = Date.now();
  const start = encodeURIComponent(new Date(now - 86_400_000).toISOString());
  const end = encodeURIComponent(new Date(now + 14 * 86_400_000).toISOString());
  let url = `${base}/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=100`;
  const items = [];
  for (let page = 0; url && page < 5; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CANVAS_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Canvas answered ${res.status}`);
    items.push(...(await res.json()));
    url = nextLink(res.headers.get('link'));
  }
  const kinds = new Set(['assignment', 'quiz', 'discussion_topic', 'planner_note']);
  return items
    .filter((it) => kinds.has(it.plannable_type))
    .filter((it) => !(it.submissions && (it.submissions.submitted || it.submissions.excused)))
    .filter((it) => !(it.planner_override && it.planner_override.marked_complete))
    .map((it) => ({
      id: `${it.plannable_type}-${it.plannable_id}`,
      title: (it.plannable && it.plannable.title) || 'Untitled',
      course: it.context_name || 'Personal',
      dueAt: (it.plannable && (it.plannable.due_at || it.plannable.todo_date)) || it.plannable_date || null,
      url: it.html_url ? (it.html_url.startsWith('http') ? it.html_url : base + it.html_url) : null,
    }));
}

async function canvasFromFeed() {
  const res = await fetch(env.CANVAS_FEED_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Calendar feed answered ${res.status}`);
  const lines = (await res.text()).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const tasks = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT' && ev) {
      if (/assignment/i.test(ev.UID || '')) {
        const summary = (ev.SUMMARY || 'Untitled').replace(/\\([,;\\])/g, '$1');
        const course = summary.match(/\s*\[([^\]]+)\]\s*$/);
        const d = (ev.DTSTART || '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
        // UTC times end in Z; all-day dates become 23:59 Pacific (approximated as 06:59Z next day).
        const dueAt = d ? new Date(Date.UTC(+d[1], +d[2] - 1, +d[3] + (d[4] ? 0 : 1), d[4] ? +d[4] : 6, d[4] ? +d[5] : 59)).toISOString() : null;
        tasks.push({
          id: ev.UID,
          title: course ? summary.slice(0, course.index).trim() : summary,
          course: course ? course[1] : 'bCourses',
          dueAt,
          url: ev.URL || null,
        });
      }
      ev = null;
    } else if (ev) {
      const colon = line.indexOf(':');
      if (colon > 0) ev[line.slice(0, colon).split(';')[0].toUpperCase()] = line.slice(colon + 1);
    }
  }
  const now = Date.now();
  return tasks.filter((t) => !t.dueAt || (Date.parse(t.dueAt) > now - 86_400_000 && Date.parse(t.dueAt) < now + 14 * 86_400_000));
}

/** Only the owner's bCourses is read by the server (from env). Everyone else's app pushes their tasks. */
async function refreshCanvas(u) {
  if (u.id !== 'owner' || (!env.CANVAS_TOKEN && !env.CANVAS_FEED_URL)) return;
  try {
    const tasks = env.CANVAS_TOKEN ? await canvasFromApi() : await canvasFromFeed();
    u.tasks = tasks.slice(0, 100);
    save();
  } catch (err) {
    console.error('Canvas refresh failed, using the last known tasks:', err.message);
  }
}

// ---------- Twilio REST ----------

function publicBase(req) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  if (req && req.headers.host && !/^(localhost|127\.)/.test(req.headers.host)) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${req.headers.host}`;
  }
  if (data.publicBase) return data.publicBase; // last address we were reached at
  const replit = (env.REPLIT_DOMAINS || '').split(',')[0] || env.REPLIT_DEV_DOMAIN;
  if (replit) return `https://${replit}`;
  return `http://localhost:${PORT}`;
}

const openSignups = () => String(env.OPEN_SIGNUPS || '').toLowerCase() === 'true';
const signupsOpen = () => openSignups() || !!env.REGISTER_CODE;
const MAX_CALLS_PER_USER_PER_DAY = Number(env.MAX_CALLS_PER_USER_PER_DAY || 10);
const MAX_CALLS_PER_DAY = Number(env.MAX_CALLS_PER_DAY || 300);
const MAX_SIGNUPS_PER_DAY = Number(env.MAX_SIGNUPS_PER_DAY || 200);

/** Counters for the global limits, reset at midnight UTC. */
function globalToday() {
  const date = new Date().toISOString().slice(0, 10);
  if (data.global.date !== date) data.global = { date, calls: 0, signups: 0 };
  return data.global;
}

async function placeCall(req, u, opts = {}) {
  await refreshCanvas(u);
  const to = phoneOf(u);
  if (!to) throw httpError(400, 'No phone number to call. Set one in the app (Settings).');
  const date = localDate(u);
  if (u.calls.date !== date) u.calls = { date, count: 0 };
  if (u.calls.count >= MAX_CALLS_PER_USER_PER_DAY) throw httpError(429, 'Too many calls today. Try again tomorrow.');
  const g = globalToday();
  if (g.calls >= MAX_CALLS_PER_DAY) throw httpError(429, 'The call server reached its daily limit. Try again tomorrow.');
  const base = publicBase(req);
  const callId =
    PROVIDER === 'cartesia' ? await placeCartesiaCall(u, to, opts)
    : PROVIDER === 'telnyx' ? await placeTelnyxCall(u, to, base)
    : await placeTwilioCall(u, to, base);
  u.calls.count += 1;
  g.calls += 1;
  u.lastCallAt = new Date().toISOString();
  u.lastCallStatus = 'queued';
  logCall(u, opts.reason === 'stuck' ? 'stuck' : 'morning');
  save();
  return callId;
}

// ---------- impact: did the call help the student commit to something? ----------
// Each placed call is logged; the plan/step tools mark it "committed". This is the number we report as impact
// (committed calls / placed calls), and what Claude turns into a short, kind summary for the student.
const CALL_LOG_MAX = 60;
const COMMIT_WINDOW_MS = 30 * 60 * 1000;
const IMPACT_DAYS = 14;

function logCall(u, kind) {
  if (!Array.isArray(u.callLog)) u.callLog = [];
  u.callLog.push({ at: new Date().toISOString(), kind, outcome: 'placed' });
  if (u.callLog.length > CALL_LOG_MAX) u.callLog.splice(0, u.callLog.length - CALL_LOG_MAX);
}

/** The newest still-open call of this kind (within 30 minutes) becomes "committed". */
function markCommitted(u, kind) {
  const cutoff = Date.now() - COMMIT_WINDOW_MS;
  const log = Array.isArray(u.callLog) ? u.callLog : [];
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i];
    if (e.kind === kind && e.outcome === 'placed' && Date.parse(e.at) >= cutoff) {
      e.outcome = 'committed';
      e.committedAt = new Date().toISOString();
      return true;
    }
  }
  return false;
}

function impactOf(users, days = IMPACT_DAYS) {
  const since = Date.now() - days * 864e5;
  let calls = 0;
  let committed = 0;
  const seconds = [];
  for (const u of users) {
    for (const e of Array.isArray(u.callLog) ? u.callLog : []) {
      if (Date.parse(e.at) < since) continue;
      calls += 1;
      if (e.outcome === 'committed') {
        committed += 1;
        seconds.push(Math.max(0, Math.round((Date.parse(e.committedAt) - Date.parse(e.at)) / 1000)));
      }
    }
  }
  seconds.sort((a, b) => a - b);
  return {
    days,
    calls,
    committed,
    commitRate: calls ? Math.round((committed / calls) * 100) : null,
    medianSecondsToCommit: seconds.length ? seconds[Math.floor(seconds.length / 2)] : null,
  };
}

/** Claude writes two kind sentences from the student's own numbers; a fixed sentence is the fallback. */
async function impactSummary(u) {
  const stats = impactOf([u]);
  if (stats.calls === 0) return '';
  const fallback =
    `In the last ${stats.days} days Concentr8 called you ${stats.calls} time${stats.calls === 1 ? '' : 's'} ` +
    `and you picked something to start on ${stats.committed} of them.`;
  const date = localDate(u);
  const key = `${date}:${stats.calls}:${stats.committed}`; // new numbers, new summary; same numbers, same text
  if (u.impactText && u.impactText.key === key) return u.impactText.text;
  let text = fallback;
  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: claudeModel(),
          max_tokens: 120,
          system:
            'You write a short note to a UC Berkeley student with ADHD about how their morning calls went. ' +
            'Use ONLY the numbers given, never invent any. Two sentences at most, warm, specific, no guilt, no advice, ' +
            'no emojis, no markdown. Celebrate starting, not perfection.',
          messages: [{ role: 'user', content: JSON.stringify(stats) }],
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const body = await res.json();
        const t = String(body.content?.find((c) => c.type === 'text')?.text || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 20 && t.length <= 400) {
          text = t;
          noteClaude('summary', true);
        } else {
          console.error('[summary] Claude answer did not fit; using the fixed sentence');
          noteClaude('summary', false, 'answer did not fit');
        }
      } else {
        const why = await claudeError(res);
        console.error(`[summary] ${why}; using the fixed sentence`);
        noteClaude('summary', false, why);
      }
    } catch (err) {
      console.error('[summary] Claude request failed; using the fixed sentence:', err.name, err.message);
      noteClaude('summary', false, err.name);
    }
  }
  u.impactText = { key, text };
  save();
  return text;
}

/**
 * Cartesia voice agent: https://docs.cartesia.ai/line/integrations/telephony/outbound-dialing
 * The agent greets with {{opening_line}} and saves the plan by calling our /cartesia/save-plan webhook tool
 * with {{user_id}}, so the answer lands with the right student.
 */
async function placeCartesiaCall(u, to, opts = {}) {
  const { CARTESIA_API_KEY: key, CARTESIA_PHONE_NUMBER_ID: from } = env;
  const stuck = opts.reason === 'stuck';
  const agent = stuck ? env.CARTESIA_STUCK_AGENT_ID : env.CARTESIA_AGENT_ID;
  if (!key || !agent || !from) {
    throw httpError(500, 'Cartesia is not configured (CARTESIA_API_KEY, CARTESIA_AGENT_ID, CARTESIA_PHONE_NUMBER_ID)');
  }
  const variables = stuck
    ? { user_id: u.id, opening_line: stuckOpeningLine(opts.task), task: opts.task || 'their task' }
    : { user_id: u.id, opening_line: await claudeOpeningLine(u) };
  const res = await fetch('https://api.cartesia.ai/agents/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Cartesia-Version': env.CARTESIA_VERSION || '2026-08-14', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_number_id: from,
      agent_id: agent,
      outbound_calls: [{ to_number: to, dynamic_variables: variables }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  const upstream = (e) => (typeof e === 'string' ? e : e && (e.message || e.detail || JSON.stringify(e)));
  if (!res.ok) throw httpError(502, `Cartesia: ${upstream(body.message) || upstream(body.error) || upstream(body.detail) || res.status}`);
  const call = Array.isArray(body.calls) ? body.calls[0] : null;
  // A 200 does not mean the call started: every entry has either an id or an error.
  if (!call || call.error || !call.agent_call_id) throw httpError(502, `Cartesia: ${(call && upstream(call.error)) || 'the call did not start'}`);
  return call.agent_call_id;
}

/** Telnyx TeXML: https://developers.telnyx.com/api-reference/texml-rest-commands/initiate-an-outbound-call */
async function placeTelnyxCall(u, to, base) {
  const { TELNYX_API_KEY: key, TELNYX_ACCOUNT_SID: account, TELNYX_APP_ID: app, TELNYX_PHONE_NUMBER: from } = env;
  if (!key || !account || !app || !from) {
    throw httpError(500, 'Telnyx is not configured (TELNYX_API_KEY, TELNYX_ACCOUNT_SID, TELNYX_APP_ID, TELNYX_PHONE_NUMBER)');
  }
  const res = await fetch(`https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(account)}/Calls`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      To: to,
      From: from,
      ApplicationSid: app,
      Url: `${base}/twilio/voice?u=${u.id}`,
      UrlMethod: 'POST',
      StatusCallback: `${base}/twilio/status?u=${u.id}`,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body.errors && body.errors[0]) || {};
    const detail = [e.title, e.detail].filter(Boolean).join(': ') || body.message || res.status;
    throw httpError(502, `Telnyx: ${detail}${e.code ? ` (error ${e.code})` : ''}`);
  }
  return body.sid || body.call_sid || body.CallSid || 'telnyx-call';
}

async function placeTwilioCall(u, to, base) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) throw httpError(500, 'Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)');

  const form = new URLSearchParams({
    To: to,
    From: from,
    Url: `${base}/twilio/voice?u=${u.id}`,
    Method: 'POST',
    StatusCallback: `${base}/twilio/status?u=${u.id}`,
    StatusCallbackMethod: 'POST',
  });
  for (const e of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', e);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body.code ? ` (error ${body.code}${body.more_info ? `, see ${body.more_info}` : ''})` : '';
    throw httpError(502, `Twilio: ${body.message || res.status}${code}`);
  }
  return body.sid;
}

/** Webhook bodies: Twilio sends form fields; accept JSON too, in case a carrier does. */
function webhookParams(raw, contentType) {
  if (/json/i.test(contentType || '')) {
    try {
      const obj = JSON.parse(raw || '{}');
      const flat = obj.data && obj.data.payload ? { ...obj.data.payload, ...obj } : obj;
      return new URLSearchParams(Object.entries(flat).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, String(v)]));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

const firstParam = (params, names) => {
  for (const n of names) {
    const v = params.get(n);
    if (v) return v;
  }
  return '';
};

/** Optional check that webhooks really come from Twilio (set VALIDATE_TWILIO_SIGNATURE=true). */
function validTwilioSignature(req, params) {
  if (env.VALIDATE_TWILIO_SIGNATURE !== 'true') return true;
  const signature = req.headers['x-twilio-signature'];
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;
  const url = publicBase(req) + req.url;
  const payload = url + [...params.keys()].sort().map((k) => k + params.get(k)).join('');
  const expected = crypto.createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(payload).digest('base64');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ---------- HTTP plumbing ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(httpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

/** The student a request belongs to: the owner (APP_API_KEY) or someone who signed up (their own token). */
function userFromRequest(req, url) {
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
  if (!given) return null;
  if (env.APP_API_KEY && safeEqual(given, env.APP_API_KEY)) return owner();
  const hash = sha256(given);
  return Object.values(data.users).find((u) => u.tokenHash && safeEqual(u.tokenHash, hash)) || null;
}

function todayResponse(u) {
  const t = today(u);
  return {
    date: t.date,
    focusTask: t.focusTask,
    startTime: t.startTime,
    lastCallAt: u.lastCallAt,
    lastCallStatus: u.lastCallStatus,
    firstStep: t.firstStep || null, // agreed on a stuck call
    firstStepAt: t.firstStepAt || null,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- routes ----------

/** Which student a phone-provider webhook is about: ?u=<id>, else the number that called us. */
function webhookUser(url, params) {
  const id = url.searchParams.get('u');
  if (id && data.users[id]) return data.users[id];
  const direction = firstParam(params, ['Direction', 'direction']);
  const from = firstParam(params, ['From', 'from']);
  const to = firstParam(params, ['To', 'to']);
  return userByPhone(direction.startsWith('inbound') || !direction ? from : to) || userByPhone(to);
}

/** Applies { phoneNumber, callTime, timezone, paused } to a student; throws 400 on bad values. */
function applySettings(u, body) {
  if (typeof body.phoneNumber === 'string' && body.phoneNumber.trim()) {
    const phone = normalizePhone(body.phoneNumber);
    if (!phone) throw httpError(400, 'That phone number does not look right. Use the +1 415 555 1234 format.');
    u.phoneNumber = phone;
  }
  if (typeof body.callTime === 'string') {
    if (!HHMM.test(body.callTime)) throw httpError(400, 'callTime must look like 08:00');
    u.callTime = body.callTime;
  }
  if (typeof body.timezone === 'string') {
    if (!validTimezone(body.timezone)) throw httpError(400, 'Unknown timezone');
    u.timezone = body.timezone;
  }
  if (typeof body.paused === 'boolean') u.paused = body.paused;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  // Remember our public address so the 8:00 scheduler can give the phone provider the right webhook URL.
  if (req.headers.host && !/^(localhost|127\.)/.test(req.headers.host)) {
    const seen = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    if (data.publicBase !== seen) {
      data.publicBase = seen;
      save();
    }
  }

  if (m === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if (p === '/' && m === 'GET') {
    const page = require('path').join(__dirname, 'public', 'index.html');
    let html;
    try { html = require('fs').readFileSync(page, 'utf8'); } catch { return send(res, 200, 'Concentr8 call server is running. See /api/health.', 'text/plain'); }
    const dl = env.DOWNLOAD_BASE_URL || 'https://github.com/concentr8-app/concentr8/releases/latest/download';
    return send(res, 200, html.split('{{DOWNLOAD_BASE}}').join(dl), 'text/html; charset=utf-8');
  }
  // Aggregate numbers only (no names, no phone numbers): what the morning call achieves across all students.
  if (p === '/api/impact' && m === 'GET') {
    const users = Object.values(data.users);
    const all = impactOf(users);
    return send(res, 200, { ...all, students: users.filter((x) => (x.callLog || []).length > 0).length });
  }
  if (p === '/api/health' && m === 'GET') {
    return send(res, 200, {
      ok: true,
      provider: PROVIDER,
      telnyxKey: !!env.TELNYX_API_KEY,
      telnyxAccount: !!env.TELNYX_ACCOUNT_SID,
      telnyxApp: !!env.TELNYX_APP_ID,
      telnyxNumber: !!env.TELNYX_PHONE_NUMBER,
      cartesiaKey: !!env.CARTESIA_API_KEY,
      cartesiaAgent: !!env.CARTESIA_AGENT_ID,
      cartesiaNumber: !!env.CARTESIA_PHONE_NUMBER_ID,
      cartesiaToolSecret: !!env.CARTESIA_WEBHOOK_SECRET,
      cartesiaStuckAgent: !!env.CARTESIA_STUCK_AGENT_ID,
      features: [...(stuckCallReady() ? ['stuck-call'] : []), ...(env.ANTHROPIC_API_KEY ? ['first-step', 'relevance'] : [])],
      build: BUILD,
      claude: { key: !!env.ANTHROPIC_API_KEY, model: claudeModel(), ...claudeStatus },
      users: Object.keys(data.users).length,
      signupsOpen: signupsOpen(),
      inviteRequired: !openSignups() && !!env.REGISTER_CODE,
      publicBase: publicBase(req),
    });
  }

  // --- sign-up (no login yet; closed, invite code, or open to everyone with OPEN_SIGNUPS=true) ---
  if (p === '/api/register' && m === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!signupsOpen()) throw httpError(403, 'Sign-ups are closed on this server.');
    if (!openSignups() && !safeEqual(String(body.inviteCode || '').trim(), env.REGISTER_CODE)) throw httpError(403, 'Wrong invite code.');
    if (body.consent !== true) throw httpError(400, 'You need to agree to get a morning phone call.');
    const phone = normalizePhone(body.phoneNumber);
    if (!phone) throw httpError(400, 'That phone number does not look right. Use the +1 415 555 1234 format.');
    const g = globalToday();
    let u = userByPhone(phone);
    // Open sign-ups cannot prove phone ownership. Reissuing an existing account therefore needs
    // a separate operator-provided recovery code rather than only the public phone number.
    if (u && openSignups()) {
      const recoveryCode = String(env.RECOVERY_CODE || '');
      const givenCode = String(body.inviteCode || '').trim();
      if (!recoveryCode || !safeEqual(givenCode, recoveryCode)) {
        throw httpError(409, 'This number is already signed up. Enter the recovery code from the Concentr8 team.');
      }
    }
    if (!u) {
      if (g.signups >= MAX_SIGNUPS_PER_DAY) throw httpError(429, 'Too many sign-ups today. Try again tomorrow.');
      g.signups += 1;
      u = newUser(crypto.randomBytes(8).toString('hex'), { phoneNumber: phone });
      data.users[u.id] = u;
    }
    applySettings(u, { callTime: body.callTime, timezone: body.timezone });
    u.consentAt = new Date().toISOString();
    u.paused = false;
    // A new token replaces the old one, so signing up again on a new Mac works.
    const token = crypto.randomBytes(24).toString('hex');
    u.tokenHash = sha256(token);
    save();
    return send(res, 200, { ok: true, userId: u.id, token });
  }

  // --- app API (Bearer token: the owner's APP_API_KEY or the student's own token) ---
  if (p.startsWith('/api/') || p.startsWith('/cron/')) {
    const u = userFromRequest(req, url);
    if (!u) return send(res, 401, { ok: false, error: 'Missing or wrong API key' });

    if (p === '/api/tasks' && m === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(body.tasks)) throw httpError(400, 'Expected { tasks: [...] }');
      u.tasks = body.tasks.slice(0, 100).map((t) => ({
        id: String(t.id ?? ''),
        title: String(t.title ?? 'Untitled').slice(0, 200),
        course: String(t.course ?? '').slice(0, 100),
        dueAt: t.dueAt ? String(t.dueAt) : null,
        url: t.url ? String(t.url) : null,
      }));
      save();
      return send(res, 200, { ok: true, count: u.tasks.length });
    }
    if (p === '/api/today' && m === 'GET') return send(res, 200, todayResponse(u));
    if (p === '/api/first-step' && m === 'POST') {
      if (!env.ANTHROPIC_API_KEY) throw httpError(503, 'This call server has no Claude key.');
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { throw httpError(400, 'The request body is not valid JSON.'); }
      const date = localDate(u);
      if (!u.steps || u.steps.date !== date) u.steps = { date, count: 0 };
      if (u.steps.count >= MAX_STEPS_PER_USER_PER_DAY) throw httpError(429, 'Too many steps today.');
      const g = globalToday();
      if ((g.steps || 0) >= MAX_STEPS_PER_DAY) throw httpError(429, 'The server reached its daily step limit.');
      const result = await claudeFirstStep(body);
      u.steps.count += 1;
      g.steps = (g.steps || 0) + 1;
      save();
      return send(res, 200, result);
    }
    if (p === '/api/relevance' && m === 'POST') {
      if (!env.ANTHROPIC_API_KEY) throw httpError(503, 'This call server has no Claude key.');
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { throw httpError(400, 'The request body is not valid JSON.'); }
      return send(res, 200, await claudeRelevance(body));
    }
    if (p === '/api/tasks' && m === 'GET') {
      await refreshCanvas(u);
      return send(res, 200, { tasks: u.tasks });
    }
    if (p === '/api/me' && m === 'GET') {
      return send(res, 200, { id: u.id, phoneNumber: phoneOf(u), callTime: u.callTime, timezone: u.timezone, paused: u.paused });
    }
    if (p === '/api/me/impact' && m === 'GET') {
      return send(res, 200, { ...impactOf([u]), summary: await impactSummary(u) });
    }
    if (p === '/api/me' && m === 'DELETE') {
      if (u.id === 'owner') throw httpError(400, 'The owner account cannot be deleted from the app.');
      delete data.users[u.id];
      save();
      return send(res, 200, { ok: true });
    }
    if ((p === '/api/call-now' && m === 'POST') || (p === '/cron/morning' && m === 'GET')) {
      let opts = {};
      if (m === 'POST') {
        // Older apps send no body: that is the morning call.
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { throw httpError(400, 'The request body is not valid JSON.'); }
        if (body && body.reason === 'stuck') {
          if (!stuckCallReady()) throw httpError(400, 'This call server cannot place a stuck call.');
          opts = { reason: 'stuck', task: cleanTask(body.task) };
        }
      }
      if (!opts.reason) u.paused = false; // asking for a morning call again ends a "stop"
      const callSid = await placeCall(req, u, opts);
      // A cron hit at/after call time counts as today's morning call; a test hit at 2 a.m. doesn't.
      if (p === '/cron/morning' && localHHMM(u) >= (u.callTime || '08:00')) u.lastAutoCallDate = localDate(u);
      save();
      return send(res, 200, { ok: true, callSid });
    }
    if (p === '/cron/tick' && m === 'GET') {
      // For hosts that sleep: an external cron opens this every few minutes (owner key only).
      if (u.id !== 'owner') return send(res, 403, { ok: false, error: 'Owner key required' });
      return send(res, 200, { ok: true, called: schedulerTick() });
    }
    if (p === '/api/cartesia/numbers' && m === 'GET') {
      // Owner helper: shows the ID of your Cartesia phone number (CARTESIA_PHONE_NUMBER_ID).
      if (u.id !== 'owner') return send(res, 403, { ok: false, error: 'Owner key required' });
      if (!env.CARTESIA_API_KEY) throw httpError(500, 'CARTESIA_API_KEY is not set');
      const r = await fetch('https://api.cartesia.ai/agents/phone-numbers', {
        headers: { Authorization: `Bearer ${env.CARTESIA_API_KEY}`, 'Cartesia-Version': env.CARTESIA_VERSION || '2026-08-14' },
        signal: AbortSignal.timeout(10_000),
      });
      return send(res, 200, { status: r.status, body: await r.json().catch(() => null) });
    }
    if (p === '/api/settings' && m === 'POST') {
      applySettings(u, JSON.parse((await readBody(req)) || '{}'));
      save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  }

  // --- Cartesia agent tool: the voice agent saves what the student said (Bearer CARTESIA_WEBHOOK_SECRET) ---
  if (p === '/cartesia/save-plan' && m === 'POST') {
    const header = req.headers.authorization || '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!env.CARTESIA_WEBHOOK_SECRET) throw httpError(503, 'CARTESIA_WEBHOOK_SECRET is not set on the server');
    if (!given || !safeEqual(given, env.CARTESIA_WEBHOOK_SECRET)) throw httpError(401, 'Wrong tool secret');
    const body = JSON.parse((await readBody(req)) || '{}');
    const u = data.users[String(body.user_id || '')];
    if (!u) throw httpError(404, 'Unknown student. Tell the student you could not save the plan and to open Concentr8 instead.');
    if (body.stop_calls === true) {
      u.paused = true;
      save();
      return send(res, 200, 'Done. The student will not get automatic calls anymore. Confirm that kindly and say goodbye.', 'text/plain');
    }
    const t = today(u);
    const firstStep = String(body.first_step || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (firstStep) {
      // From the stuck call: one tiny step for the next 5 minutes. The app polls /api/today for it.
      t.firstStep = firstStep;
      t.firstStepAt = new Date().toISOString();
      u.lastCallStatus = 'completed';
      markCommitted(u, 'stuck');
      save();
      return send(res, 200, `Saved the first step: ${firstStep.replace(/\.$/, '')}. Read it back in one short, warm sentence, say the app now shows it with a 5-minute timer, and end the call.`, 'text/plain');
    }
    const task = String(body.task || '').trim().slice(0, 200);
    const startTime = String(body.start_time || '').trim().replace(/[!?]+$/, '').slice(0, 60);
    if (!task) throw httpError(400, 'Missing task. Ask the student which task they will start.');
    if (!startTime) throw httpError(400, 'Missing start_time. Ask the student when they will start.');
    t.focusTask = task;
    t.startTime = startTime;
    u.lastCallStatus = 'completed';
    markCommitted(u, 'morning');
    save();
    return send(res, 200, `Saved: ${task} at ${startTime.replace(/\.$/, '')}. Confirm it in one short sentence, wish them luck and end the call.`, 'text/plain');
  }

  // --- phone-provider webhooks (Twilio and Telnyx TeXML speak the same XML) ---
  if (p.startsWith('/twilio/') && m === 'POST') {
    const params = webhookParams(await readBody(req), req.headers['content-type']);
    if (PROVIDER === 'twilio' && !validTwilioSignature(req, params)) return send(res, 403, 'Bad signature', 'text/plain');
    const u = webhookUser(url, params);

    if (p === '/twilio/status') {
      if (u) {
        u.lastCallStatus = firstParam(params, ['CallStatus', 'call_status', 'status']) || u.lastCallStatus;
        save();
      }
      return send(res, 204, '', 'text/plain');
    }

    if (!u) {
      // Someone phoned our number without signing up.
      return send(res, 200, twiml(say('Hi, this is Concentr8. Please sign up in the Concentr8 app to get your morning call. Bye!') + '<Hangup/>'), 'text/xml');
    }

    if (p === '/twilio/voice') {
      u.lastCallStatus = 'in-progress';
      if (firstParam(params, ['Direction', 'direction']).startsWith('inbound')) u.lastCallAt = new Date().toISOString();
      save();
      return send(res, 200, twiml(gather(u, 'task', 0, openingLine(u))), 'text/xml');
    }

    if (p === '/twilio/gather') {
      const step = url.searchParams.get('step');
      const attempt = Number(url.searchParams.get('try') || 0);
      const speech = url.searchParams.get('empty')
        ? ''
        : firstParam(params, ['SpeechResult', 'speech_result', 'Speech', 'speech', 'Transcript', 'transcript']).trim();
      if (!speech && !url.searchParams.get('empty')) {
        console.log('gather callback without speech, fields:', [...params.keys()].join(', ') || '(none)');
      }
      const t = today(u);

      if (STOP_WORDS.test(speech)) {
        u.paused = true;
        save();
        return send(res, 200, twiml(say("Okay, I won't call you again. You can turn the call back on in the Concentr8 app. Bye!") + '<Hangup/>'), 'text/xml');
      }

      if (step === 'task') {
        if (!speech) {
          if (attempt === 0) return send(res, 200, twiml(gather(u, 'task', 1, "Sorry, I didn't catch that. Which one will you start with?")), 'text/xml');
          return send(res, 200, twiml(say("No worries. Open Concentr8 when you're ready, and pick one there. Bye!") + '<Hangup/>'), 'text/xml');
        }
        const smart = await claudeUnderstand(u, speech);
        t.focusTask = (smart && smart.task) || cleanAnswer(speech) || speech;
        save();
        const reply = (smart && smart.reply) || `Great, ${t.focusTask}. When will you start? For example, nine thirty.`;
        return send(res, 200, twiml(gather(u, 'time', 0, reply)), 'text/xml');
      }

      if (step === 'time') {
        if (!speech) {
          if (attempt === 0) return send(res, 200, twiml(gather(u, 'time', 1, 'When will you start? You can say a time, or now.')), 'text/xml');
          return send(res, 200, twiml(say(`Okay. Start ${t.focusTask || 'it'} whenever you're ready. I'll keep distractions away. Bye!`) + '<Hangup/>'), 'text/xml');
        }
        t.startTime = speech.replace(/[!?]+$/, ''); // keep the dot in "a.m."
        save();
        return send(
          res,
          200,
          twiml(say(`Locked in: ${t.focusTask || 'your task'}, at ${t.startTime.replace(/\.$/, '')}. I'll keep distractions away. Go get it!`) + '<Hangup/>'),
          'text/xml',
        );
      }
    }
  }

  return send(res, 404, { ok: false, error: 'Not found' });
}

/** Says "stop" (or similar) on the phone: we stop the automatic calls. */
const STOP_WORDS = /\b(stop (calling|calls)|don'?t call|do not call|unsubscribe|opt out|remove me|leave me alone)\b|^stop\b/i;

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(err);
    if (req.url.startsWith('/twilio/')) {
      // Never leave the caller in silence.
      return send(res, 200, twiml(say('Sorry, something went wrong on my side. Talk soon!') + '<Hangup/>'), 'text/xml');
    }
    send(res, status, { ok: false, error: err.message });
  });
});

// ---------- daily scheduler ----------

/** Places today's morning call for everyone whose call time just passed. Returns how many calls were started. */
function schedulerTick() {
  let started = 0;
  for (const u of Object.values(data.users)) {
    if (u.paused || !phoneOf(u)) continue;
    if (u.id !== 'owner' && !u.consentAt) continue;
    const date = localDate(u);
    if (u.lastAutoCallDate === date) continue;
    // Fire once in the first 15 minutes after the call time (survives a restart a few minutes late).
    const [th, tm] = (u.callTime || '08:00').split(':').map(Number);
    const [nh, nm] = localHHMM(u).split(':').map(Number);
    const late = nh * 60 + nm - (th * 60 + tm);
    if (late < 0 || late > 15) continue;
    u.lastAutoCallDate = date;
    save();
    started += 1;
    placeCall(null, u)
      .then((sid) => console.log(`[${new Date().toISOString()}] morning call placed for ${u.id}: ${sid}`))
      .catch((err) => console.error(`morning call for ${u.id} failed:`, err.message));
  }
  return started;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Concentr8 call server on :${PORT} (public: ${publicBase(null)}, calls via ${PROVIDER})`);
    if (!env.APP_API_KEY) console.warn('APP_API_KEY is not set: only students who signed up can use the app API.');
    if (!signupsOpen()) console.warn('Sign-ups are closed: set OPEN_SIGNUPS=true (anyone) or REGISTER_CODE (invite code).');
  });
  setInterval(schedulerTick, 30_000);
  schedulerTick();
  void claudeSelfTest();
  setInterval(() => void claudeSelfTest(), 12 * 60 * 60 * 1000).unref();
}

module.exports = { server, cleanAnswer, openingLine, claudeOpeningLine, greetingFor, claudeSelfTest, claudeStatus, spokenCourse, normalizePhone, schedulerTick, data };
