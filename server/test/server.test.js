'use strict';
// Run: node --test server/test   (no network: the phone provider is replaced by a fake fetch)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-'));
process.env.DATA_FILE = path.join(dir, 'data.json');
process.env.APP_API_KEY = 'owner-key';
process.env.REGISTER_CODE = 'calhacks';
process.env.TELNYX_API_KEY = 'k';
process.env.TELNYX_ACCOUNT_SID = 'acct';
process.env.TELNYX_APP_ID = 'app';
process.env.TELNYX_PHONE_NUMBER = '+15106606154';
process.env.USER_PHONE_NUMBER = '+13412197358';
process.env.MAX_CALLS_PER_USER_PER_DAY = '2';
delete process.env.ANTHROPIC_API_KEY;

const { server, normalizePhone, schedulerTick, data } = require('../index.js');

const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telnyx.com/')) {
    calls.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ sid: 'fake-call' }), { status: 200 });
  }
  return realFetch(url, opts);
};

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const api = (p, { method = 'GET', key, body } = {}) =>
  fetch(base + p, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
const form = (p, fields) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

const signup = async (phone, extra = {}) => {
  const r = await api('/api/register', {
    method: 'POST',
    body: { phoneNumber: phone, inviteCode: 'calhacks', consent: true, callTime: '08:00', timezone: 'America/Los_Angeles', ...extra },
  });
  return { status: r.status, ...(await r.json()) };
};

test('phone numbers are normalised', () => {
  assert.equal(normalizePhone('(415) 555-1234'), '+14155551234');
  assert.equal(normalizePhone('1 415 555 1234'), '+14155551234');
  assert.equal(normalizePhone('+49 1512 3456789'), '+4915123456789');
  assert.equal(normalizePhone('hello'), null);
  assert.equal(normalizePhone('12345'), null);
});

test('sign-up needs the invite code and consent', async () => {
  assert.equal((await api('/api/register', { method: 'POST', body: { phoneNumber: '4155551234', inviteCode: 'nope', consent: true } })).status, 403);
  assert.equal((await api('/api/register', { method: 'POST', body: { phoneNumber: '4155551234', inviteCode: 'calhacks', consent: false } })).status, 400);
  assert.equal((await api('/api/register', { method: 'POST', body: { phoneNumber: 'abc', inviteCode: 'calhacks', consent: true } })).status, 400);
});

test('every student has their own tasks, answers and settings', async () => {
  const a = await signup('4155551111');
  const b = await signup('4155552222', { callTime: '09:30' });
  assert.equal(a.status, 200);
  assert.notEqual(a.token, b.token);

  await api('/api/tasks', { method: 'POST', key: a.token, body: { tasks: [{ id: '1', title: 'Project 2', course: 'COMPSCI 188', dueAt: null, url: null }] } });
  await api('/api/tasks', { method: 'POST', key: b.token, body: { tasks: [{ id: '9', title: 'Essay draft', course: 'ENGLISH 1A', dueAt: null, url: null }] } });

  const voiceA = await (await form(`/twilio/voice?u=${a.userId}`, { Direction: 'outbound-api' })).text();
  const voiceB = await (await form(`/twilio/voice?u=${b.userId}`, { Direction: 'outbound-api' })).text();
  assert.match(voiceA, /Project 2/);
  assert.doesNotMatch(voiceA, /Essay draft/);
  assert.match(voiceB, /Essay draft/);
  assert.match(voiceA, new RegExp(`gather\\?u=${a.userId}`));

  await form(`/twilio/gather?u=${a.userId}&step=task&try=0`, { SpeechResult: 'the CS project' });
  await form(`/twilio/gather?u=${a.userId}&step=time&try=0`, { SpeechResult: '9:30 a.m.' });
  const todayA = await (await api('/api/today', { key: a.token })).json();
  const todayB = await (await api('/api/today', { key: b.token })).json();
  assert.equal(todayA.focusTask, 'the CS project');
  assert.equal(todayA.startTime, '9:30 a.m.');
  assert.equal(todayB.focusTask, null);

  const meB = await (await api('/api/me', { key: b.token })).json();
  assert.equal(meB.callTime, '09:30');
  assert.equal(meB.phoneNumber, '+14155552222');
});

test('wrong or missing tokens are refused; the owner key still works', async () => {
  assert.equal((await api('/api/today')).status, 401);
  assert.equal((await api('/api/today', { key: 'wrong' })).status, 401);
  assert.equal((await api('/api/today', { key: 'owner-key' })).status, 200);
  assert.equal((await api('/api/me', { key: 'owner-key' })).status, 200);
});

test('manual calls repeat without re-registration until the per-user daily cap', async () => {
  const c = await signup('4155553333');
  calls.length = 0;
  assert.equal((await api('/api/call-now', { method: 'POST', key: c.token, body: {} })).status, 200);
  assert.equal(calls[0].To, '+14155553333');
  assert.equal(calls[0].Url.includes(`/twilio/voice?u=${c.userId}`), true);
  assert.equal((await api('/api/call-now', { method: 'POST', key: c.token, body: {} })).status, 200);
  assert.equal((await api('/api/call-now', { method: 'POST', key: c.token, body: {} })).status, 429);
});

test('saying "stop" pauses the morning calls; asking for a call again resumes', async () => {
  const d = await signup('4155554444');
  const r = await (await form(`/twilio/gather?u=${d.userId}&step=task&try=0`, { SpeechResult: "please don't call me again" })).text();
  assert.match(r, /won&apos;t call you again/);
  assert.equal((await (await api('/api/me', { key: d.token })).json()).paused, true);
  await api('/api/call-now', { method: 'POST', key: d.token, body: {} });
  assert.equal((await (await api('/api/me', { key: d.token })).json()).paused, false);
});

test('the scheduler calls each student at their own local time, once a day, never paused ones', async () => {
  const hhmm = (tz) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
    return `${p.find((x) => x.type === 'hour').value}:${p.find((x) => x.type === 'minute').value}`;
  };
  const now = hhmm('Europe/Berlin');
  const e = await signup('4155555555', { callTime: now, timezone: 'Europe/Berlin' });
  const f = await signup('4155556666', { callTime: now, timezone: 'Europe/Berlin' });
  await api('/api/settings', { method: 'POST', key: f.token, body: { paused: true } });
  // Everyone else from earlier tests is paused, so their own call times (e.g. 8:00 in Berkeley) never make this flaky.
  for (const u of Object.values(data.users)) if (u.id !== e.userId) u.paused = true;
  data.users[e.userId].lastAutoCallDate = null;
  data.users[e.userId].calls = { date: null, count: 0 };
  calls.length = 0;
  assert.equal(schedulerTick(), 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].To, '+14155555555');
  assert.equal(schedulerTick(), 0, 'only once a day');

  assert.equal((await api('/api/call-now', { method: 'POST', key: e.token, body: {} })).status, 200, 'manual call still works after the scheduled call');
  assert.equal(schedulerTick(), 0, 'manual calls do not unlock another scheduled call');
  assert.equal((await api('/api/call-now', { method: 'POST', key: e.token, body: {} })).status, 429, 'scheduled and manual calls share the safety cap');
});

test('a stranger who phones our number is told to sign up', async () => {
  const r = await (await form('/twilio/voice', { Direction: 'inbound', From: '+14150000000' })).text();
  assert.match(r, /sign up in the Concentr8 app/);
});

test('students can delete their account', async () => {
  const g = await signup('4155557777');
  assert.equal((await api('/api/me', { method: 'DELETE', key: g.token })).status, 200);
  assert.equal((await api('/api/today', { key: g.token })).status, 401);
});

test('the first version\'s data file becomes the owner', () => {
  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ tasks: [{ id: 'x', title: 'Old task' }], settings: { phoneNumber: '+13412197358', callTime: '07:45', timezone: 'America/Los_Angeles' }, today: { date: null, focusTask: null, startTime: null } }));
  const { spawnSync } = require('node:child_process');
  const out = spawnSync(process.execPath, ['-e', `process.env.DATA_FILE=${JSON.stringify(legacy)};const s=require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});console.log(JSON.stringify(s.data.users.owner))`], { encoding: 'utf8' });
  const owner = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(owner.callTime, '07:45');
  assert.equal(owner.tasks[0].title, 'Old task');
});

test('health does not leak secrets or phone numbers', async () => {
  const h = await (await api('/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.signupsOpen, true);
  assert.equal(JSON.stringify(h).includes('+1'), false);
});
