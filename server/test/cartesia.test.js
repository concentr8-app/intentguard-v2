'use strict';
// The Cartesia voice agent: placing the call and the tool the agent uses to save the plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c8c-'));
Object.assign(process.env, {
  DATA_FILE: path.join(dir, 'data.json'),
  APP_API_KEY: 'owner-key',
  REGISTER_CODE: 'calhacks',
  CARTESIA_API_KEY: 'sk_car_test',
  CARTESIA_AGENT_ID: 'agent_123',
  CARTESIA_PHONE_NUMBER_ID: 'ap_456',
  CARTESIA_WEBHOOK_SECRET: 'tool-secret',
  USER_PHONE_NUMBER: '+13412197358',
});
delete process.env.CALL_PROVIDER;
delete process.env.TELNYX_API_KEY;

const { server, data } = require('../index.js');

const cartesiaCalls = [];
let cartesiaAnswer = (body) => ({ status: 200, json: { calls: [{ agent_call_id: 'call_1' }] } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.cartesia.ai/')) {
    cartesiaCalls.push({ url: String(url), headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const a = cartesiaAnswer(opts.body ? JSON.parse(opts.body) : null);
    return new Response(JSON.stringify(a.json), { status: a.status });
  }
  return realFetch(url, opts);
};

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

const post = (p, body, key) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

async function signup(phone) {
  const r = await post('/api/register', { phoneNumber: phone, inviteCode: 'calhacks', consent: true });
  return r.json();
}

test('Cartesia is the default when it is fully configured', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.provider, 'cartesia');
  assert.deepEqual([h.cartesiaKey, h.cartesiaAgent, h.cartesiaNumber, h.cartesiaToolSecret], [true, true, true, true]);
});

test('the call starts the agent with the student id and their opening line', async () => {
  const s = await signup('4155551111');
  await post('/api/tasks', { tasks: [{ id: '1', title: 'Project 2', course: 'COMPSCI 188', dueAt: null, url: null }] }, s.token);
  cartesiaCalls.length = 0;
  const r = await post('/api/call-now', {}, s.token);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).callSid, 'call_1');
  const c = cartesiaCalls[0];
  assert.equal(c.url, 'https://api.cartesia.ai/agents/calls');
  assert.equal(c.headers.Authorization, 'Bearer sk_car_test');
  assert.ok(c.headers['Cartesia-Version']);
  assert.equal(c.body.from_number_id, 'ap_456');
  assert.equal(c.body.agent_id, 'agent_123');
  assert.equal(c.body.outbound_calls[0].to_number, '+14155551111');
  assert.equal(c.body.outbound_calls[0].dynamic_variables.user_id, s.userId);
  assert.match(c.body.outbound_calls[0].dynamic_variables.opening_line, /Project 2 for CompSci 188/);
});

test('an error inside a 200 answer is reported, not swallowed', async () => {
  const s = await signup('4155552222');
  cartesiaAnswer = () => ({ status: 200, json: { calls: [{ error: 'Destination not allowed' }] } });
  const r = await post('/api/call-now', {}, s.token);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /Destination not allowed/);
  cartesiaAnswer = () => ({ status: 401, json: { message: 'Invalid API key' } });
  const r2 = await post('/api/call-now', {}, s.token);
  assert.match((await r2.json()).error, /Invalid API key/);
  cartesiaAnswer = () => ({ status: 200, json: { calls: [{ agent_call_id: 'call_1' }] } });
});

test('the agent saves the plan through the tool, for the right student only', async () => {
  const a = await signup('4155553333');
  const b = await signup('4155554444');
  const r = await post('/cartesia/save-plan', { user_id: a.userId, task: 'CS 188 project', start_time: '9:30 a.m.' }, 'tool-secret');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Saved: CS 188 project at 9:30 a\.m\./);
  const todayA = await (await fetch(base + '/api/today', { headers: { Authorization: `Bearer ${a.token}` } })).json();
  const todayB = await (await fetch(base + '/api/today', { headers: { Authorization: `Bearer ${b.token}` } })).json();
  assert.equal(todayA.focusTask, 'CS 188 project');
  assert.equal(todayA.startTime, '9:30 a.m.');
  assert.equal(todayA.lastCallStatus, 'completed');
  assert.equal(todayB.focusTask, null);
});

test('the tool refuses a wrong secret, an unknown student and an incomplete plan', async () => {
  const a = await signup('4155555555');
  assert.equal((await post('/cartesia/save-plan', { user_id: a.userId, task: 'x', start_time: 'now' })).status, 401);
  assert.equal((await post('/cartesia/save-plan', { user_id: a.userId, task: 'x', start_time: 'now' }, 'wrong')).status, 401);
  assert.equal((await post('/cartesia/save-plan', { user_id: 'nobody', task: 'x', start_time: 'now' }, 'tool-secret')).status, 404);
  assert.equal((await post('/cartesia/save-plan', { user_id: a.userId, start_time: 'now' }, 'tool-secret')).status, 400);
  assert.equal((await post('/cartesia/save-plan', { user_id: a.userId, task: 'x' }, 'tool-secret')).status, 400);
});

test('"stop calling me" through the tool pauses the morning calls', async () => {
  const a = await signup('4155556666');
  const r = await post('/cartesia/save-plan', { user_id: a.userId, stop_calls: true }, 'tool-secret');
  assert.equal(r.status, 200);
  assert.equal(data.users[a.userId].paused, true);
});

test('open sign-ups: no invite code needed, but an existing number cannot be taken over', async () => {
  process.env.OPEN_SIGNUPS = 'true';
  try {
    const reg = (phone) => fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNumber: phone, consent: true }) });
    const a = await reg('+14155550111');
    assert.equal(a.status, 200);
    assert.ok((await a.json()).token);
    assert.equal((await reg('+14155550111')).status, 409);
  } finally { delete process.env.OPEN_SIGNUPS; }
});
