// Concentr8 Call Server — zero dependencies, Node 18+.
// Phones the student every morning (Twilio), asks which Canvas task they'll start and when,
// and hands the answer to the Mac app. API contract: ../docs/call-server-api.md
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

const data = Object.assign(
  {
    tasks: [],
    settings: { phoneNumber: null, callTime: '08:00', timezone: DEFAULT_TZ },
    today: { date: null, focusTask: null, startTime: null },
    lastCallAt: null,
    lastCallStatus: null,
    lastAutoCallDate: null,
  },
  loadData(),
);

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

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

const tz = () => data.settings.timezone || DEFAULT_TZ;
const localDate = (d = new Date()) => {
  const p = zoned(d, tz());
  return `${p.year}-${p.month}-${p.day}`;
};
const localHHMM = (d = new Date()) => {
  const p = zoned(d, tz());
  return `${p.hour}:${p.minute}`;
};

/** Today's record, reset after midnight in the student's timezone. */
function today() {
  const date = localDate();
  if (data.today.date !== date) data.today = { date, focusTask: null, startTime: null };
  return data.today;
}

/** "due today", "due tomorrow", "due Monday" — for reading out loud. */
function spokenDue(iso) {
  if (!iso) return '';
  const due = new Date(iso);
  const now = new Date();
  if (due < now) return ', which is overdue';
  const dayMs = 86_400_000;
  if (localDate(due) === localDate(now)) return ', due today';
  if (localDate(due) === localDate(new Date(now.getTime() + dayMs))) return ', due tomorrow';
  if (due - now < 6 * dayMs) return `, due ${zoned(due, tz()).weekday}`;
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

const VOICE = env.TWILIO_VOICE || 'Polly.Joanna-Neural';

function say(text) {
  return `<Say voice="${xml(VOICE)}">${xml(text)}</Say>`;
}

function gather(step, attempt, prompt) {
  const hints = data.tasks
    .slice(0, 8)
    .flatMap((t) => [t.title, spokenCourse(t.course)])
    .filter(Boolean)
    .join(', ')
    .slice(0, 900);
  const action = `/twilio/gather?step=${step}&amp;try=${attempt}`;
  return (
    `<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" language="en-US"` +
    (hints ? ` hints="${xml(hints)}"` : '') +
    `>${say(prompt)}</Gather>` +
    // Reached only if the student said nothing:
    `<Redirect method="POST">/twilio/gather?step=${step}&amp;try=${attempt}&amp;empty=1</Redirect>`
  );
}

const twiml = (body) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

function openingLine() {
  const hour = Number(zoned(new Date(), tz()).hour);
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Hi' : 'Good evening';
  const top = [...data.tasks]
    .sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity))
    .slice(0, 3);
  if (top.length === 0) {
    return `${greeting}, this is Concentr8. What's the one thing you want to get done today?`;
  }
  const list = top.map((t) => `${t.title} for ${spokenCourse(t.course)}${spokenDue(t.dueAt)}`).join('. ');
  const count = top.length === 1 ? 'one thing' : `${['', 'one', 'two', 'three'][top.length]} things`;
  return `${greeting}, this is Concentr8. You have ${count} coming up. ${list}. Which one will you start with?`;
}

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

async function claudeUnderstand(speech) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const tasks = data.tasks.slice(0, 10).map((t) => `- ${t.title} (${t.course})`).join('\n') || '(none)';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
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

// ---------- Twilio REST ----------

function publicBase(req) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  const replit = (env.REPLIT_DOMAINS || '').split(',')[0] || env.REPLIT_DEV_DOMAIN;
  if (replit) return `https://${replit}`;
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  }
  return `http://localhost:${PORT}`;
}

async function placeCall(req) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_PHONE_NUMBER;
  const to = data.settings.phoneNumber || env.USER_PHONE_NUMBER;
  if (!sid || !token || !from) throw httpError(500, 'Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)');
  if (!to) throw httpError(400, 'No phone number to call (set USER_PHONE_NUMBER or POST /api/settings)');

  const base = publicBase(req);
  const form = new URLSearchParams({
    To: to,
    From: from,
    Url: `${base}/twilio/voice`,
    Method: 'POST',
    StatusCallback: `${base}/twilio/status`,
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
  if (!res.ok) throw httpError(502, `Twilio: ${body.message || res.status}`);
  data.lastCallAt = new Date().toISOString();
  data.lastCallStatus = 'queued';
  save();
  return body.sid;
}

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

function authorized(req, url) {
  const key = env.APP_API_KEY;
  if (!key) return false;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function todayResponse() {
  const t = today();
  return {
    date: t.date,
    focusTask: t.focusTask,
    startTime: t.startTime,
    lastCallAt: data.lastCallAt,
    lastCallStatus: data.lastCallStatus,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- routes ----------

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if (p === '/' && m === 'GET') return send(res, 200, 'Concentr8 call server is running. See /api/health.', 'text/plain');
  if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true });

  // --- app API (Bearer APP_API_KEY) ---
  if (p.startsWith('/api/') || p.startsWith('/cron/')) {
    if (!authorized(req, url)) return send(res, 401, { ok: false, error: 'Missing or wrong API key' });

    if (p === '/api/tasks' && m === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(body.tasks)) throw httpError(400, 'Expected { tasks: [...] }');
      data.tasks = body.tasks.slice(0, 100).map((t) => ({
        id: String(t.id ?? ''),
        title: String(t.title ?? 'Untitled').slice(0, 200),
        course: String(t.course ?? '').slice(0, 100),
        dueAt: t.dueAt ? String(t.dueAt) : null,
        url: t.url ? String(t.url) : null,
      }));
      save();
      return send(res, 200, { ok: true, count: data.tasks.length });
    }
    if (p === '/api/today' && m === 'GET') return send(res, 200, todayResponse());
    if ((p === '/api/call-now' && m === 'POST') || (p === '/cron/morning' && m === 'GET')) {
      const callSid = await placeCall(req);
      // A cron hit at/after call time counts as today's morning call; a test hit at 2 a.m. doesn't.
      if (p === '/cron/morning' && localHHMM() >= (data.settings.callTime || '08:00')) data.lastAutoCallDate = localDate();
      save();
      return send(res, 200, { ok: true, callSid });
    }
    if (p === '/api/settings' && m === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.phoneNumber === 'string' && body.phoneNumber.trim()) data.settings.phoneNumber = body.phoneNumber.trim();
      if (typeof body.callTime === 'string' && HHMM.test(body.callTime)) data.settings.callTime = body.callTime;
      if (typeof body.timezone === 'string') {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
          data.settings.timezone = body.timezone;
        } catch {
          throw httpError(400, 'Unknown timezone');
        }
      }
      save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  }

  // --- Twilio webhooks ---
  if (p.startsWith('/twilio/') && m === 'POST') {
    const params = new URLSearchParams(await readBody(req));
    if (!validTwilioSignature(req, params)) return send(res, 403, 'Bad signature', 'text/plain');

    if (p === '/twilio/status') {
      data.lastCallStatus = params.get('CallStatus') || data.lastCallStatus;
      save();
      return send(res, 204, '', 'text/plain');
    }

    if (p === '/twilio/voice') {
      data.lastCallStatus = 'in-progress';
      save();
      return send(res, 200, twiml(gather('task', 0, openingLine())), 'text/xml');
    }

    if (p === '/twilio/gather') {
      const step = url.searchParams.get('step');
      const attempt = Number(url.searchParams.get('try') || 0);
      const speech = url.searchParams.get('empty') ? '' : (params.get('SpeechResult') || '').trim();
      const t = today();

      if (step === 'task') {
        if (!speech) {
          if (attempt === 0) return send(res, 200, twiml(gather('task', 1, "Sorry, I didn't catch that. Which one will you start with?")), 'text/xml');
          return send(res, 200, twiml(say("No worries. Open Concentr8 when you're ready, and pick one there. Bye!") + '<Hangup/>'), 'text/xml');
        }
        const smart = await claudeUnderstand(speech);
        t.focusTask = (smart && smart.task) || cleanAnswer(speech) || speech;
        save();
        const reply = (smart && smart.reply) || `Great, ${t.focusTask}. When will you start? For example, nine thirty.`;
        return send(res, 200, twiml(gather('time', 0, reply)), 'text/xml');
      }

      if (step === 'time') {
        if (!speech) {
          if (attempt === 0) return send(res, 200, twiml(gather('time', 1, 'When will you start? You can say a time, or now.')), 'text/xml');
          return send(res, 200, twiml(say(`Okay. Start ${t.focusTask || 'it'} whenever you're ready. I'll keep distractions away. Bye!`) + '<Hangup/>'), 'text/xml');
        }
        t.startTime = speech.replace(/[!?]+$/, ''); // keep the dot in "a.m."
        save();
        return send(
          res,
          200,
          twiml(say(`Locked in: ${t.focusTask || 'your task'}, at ${t.startTime}. I'll keep distractions away. Go get it!`) + '<Hangup/>'),
          'text/xml',
        );
      }
    }
  }

  return send(res, 404, { ok: false, error: 'Not found' });
}

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

function schedulerTick() {
  const date = localDate();
  if (data.lastAutoCallDate === date) return;
  const now = localHHMM();
  const target = data.settings.callTime || '08:00';
  // Fire once in the first 15 minutes after the call time (survives a restart a few minutes late).
  const [th, tm] = target.split(':').map(Number);
  const [nh, nm] = now.split(':').map(Number);
  const late = nh * 60 + nm - (th * 60 + tm);
  if (late < 0 || late > 15) return;
  data.lastAutoCallDate = date;
  save();
  placeCall(null)
    .then((sid) => console.log(`[${new Date().toISOString()}] morning call placed: ${sid}`))
    .catch((err) => console.error('morning call failed:', err.message));
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Concentr8 call server on :${PORT} (public: ${publicBase(null)})`);
    if (!env.APP_API_KEY) console.warn('APP_API_KEY is not set: the app API will refuse every request.');
  });
  setInterval(schedulerTick, 30_000);
  schedulerTick();
}

module.exports = { server, cleanAnswer, openingLine, spokenCourse, data };
