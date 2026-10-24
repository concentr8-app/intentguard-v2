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

/**
 * Which phone carrier places the calls. Both speak (almost) the same XML:
 *  - "twilio": TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *  - "telnyx": TELNYX_API_KEY, TELNYX_ACCOUNT_SID, TELNYX_APP_ID, TELNYX_PHONE_NUMBER
 * Defaults to Telnyx when a Telnyx key is set.
 */
const PROVIDER = (env.CALL_PROVIDER || (env.TELNYX_API_KEY ? 'telnyx' : 'twilio')).toLowerCase();

const VOICE = env.CALL_VOICE || env.TWILIO_VOICE || 'Polly.Joanna-Neural';

function say(text) {
  const ref = env.TELNYX_VOICE_KEY_REF ? ` api_key_ref="${xml(env.TELNYX_VOICE_KEY_REF)}"` : '';
  return `<Say voice="${xml(VOICE)}"${ref}>${xml(text)}</Say>`;
}

function gather(step, attempt, prompt) {
  const hints = data.tasks
    .slice(0, 8)
    .flatMap((t) => [t.title, spokenCourse(t.course)])
    .filter(Boolean)
    .join(', ')
    .slice(0, 900);
  const action = `/twilio/gather?step=${step}&amp;try=${attempt}`;
  // Twilio understands speechTimeout="auto"; Telnyx wants seconds.
  const speechTimeout = PROVIDER === 'telnyx' ? '2' : 'auto';
  return (
    `<Gather input="speech" action="${action}" timeout="6" speechTimeout="${speechTimeout}" language="en-US"` +
    (hints ? ` hints="${xml(hints)}"` : '') +
    `>${say(prompt)}</Gather>` +
    // Reached only if the student said nothing:
    `<Redirect>/twilio/gather?step=${step}&amp;try=${attempt}&amp;empty=1</Redirect>`
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

async function refreshCanvas() {
  if (!env.CANVAS_TOKEN && !env.CANVAS_FEED_URL) return;
  try {
    const tasks = env.CANVAS_TOKEN ? await canvasFromApi() : await canvasFromFeed();
    data.tasks = tasks.slice(0, 100);
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

async function placeCall(req) {
  await refreshCanvas();
  const to = data.settings.phoneNumber || env.USER_PHONE_NUMBER;
  if (!to) throw httpError(400, 'No phone number to call (set USER_PHONE_NUMBER or POST /api/settings)');
  const base = publicBase(req);
  const callId = PROVIDER === 'telnyx' ? await placeTelnyxCall(to, base) : await placeTwilioCall(to, base);
  data.lastCallAt = new Date().toISOString();
  data.lastCallStatus = 'queued';
  save();
  return callId;
}

/** Telnyx TeXML: https://developers.telnyx.com/api-reference/texml-rest-commands/initiate-an-outbound-call */
async function placeTelnyxCall(to, base) {
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
      Url: `${base}/twilio/voice`,
      UrlMethod: 'POST',
      StatusCallback: `${base}/twilio/status`,
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

async function placeTwilioCall(to, base) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) throw httpError(500, 'Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)');

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

  // Remember our public address so the 8:00 scheduler can give Twilio the right webhook URL.
  if (req.headers.host && !/^(localhost|127\.)/.test(req.headers.host)) {
    const seen = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    if (data.publicBase !== seen) {
      data.publicBase = seen;
      save();
    }
  }

  if (m === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if (p === '/' && m === 'GET') return send(res, 200, 'Concentr8 call server is running. See /api/health.', 'text/plain');
  if (p === '/api/health' && m === 'GET') return send(res, 200, { ok: true, provider: PROVIDER, telnyxKey: !!env.TELNYX_API_KEY, telnyxAccount: !!env.TELNYX_ACCOUNT_SID, telnyxApp: !!env.TELNYX_APP_ID, telnyxNumber: !!env.TELNYX_PHONE_NUMBER, phone: !!(data.settings.phoneNumber || env.USER_PHONE_NUMBER), publicBase: publicBase(req) });

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
    if (p === '/api/tasks' && m === 'GET') {
      await refreshCanvas();
      return send(res, 200, { tasks: data.tasks });
    }
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
    const params = webhookParams(await readBody(req), req.headers['content-type']);
    if (PROVIDER === 'twilio' && !validTwilioSignature(req, params)) return send(res, 403, 'Bad signature', 'text/plain');

    if (p === '/twilio/status') {
      data.lastCallStatus = firstParam(params, ['CallStatus', 'call_status', 'status']) || data.lastCallStatus;
      save();
      return send(res, 204, '', 'text/plain');
    }

    if (p === '/twilio/voice') {
      data.lastCallStatus = 'in-progress';
      if (firstParam(params, ['Direction', 'direction']).startsWith('inbound')) data.lastCallAt = new Date().toISOString();
      save();
      return send(res, 200, twiml(gather('task', 0, openingLine())), 'text/xml');
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
          twiml(say(`Locked in: ${t.focusTask || 'your task'}, at ${t.startTime.replace(/\.$/, '')}. I'll keep distractions away. Go get it!`) + '<Hangup/>'),
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
    console.log(`Concentr8 call server on :${PORT} (public: ${publicBase(null)}, calls via ${PROVIDER})`);
    if (!env.APP_API_KEY) console.warn('APP_API_KEY is not set: the app API will refuse every request.');
  });
  setInterval(schedulerTick, 30_000);
  schedulerTick();
}

module.exports = { server, cleanAnswer, openingLine, spokenCourse, data };
