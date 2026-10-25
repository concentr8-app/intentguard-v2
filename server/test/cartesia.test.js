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
const claudeCalls = [];
let claudeAnswer = () => ({ status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"step":"Open search.py and read the comment above depthFirstSearch.","minutes":5}' }] } });
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    claudeCalls.push({ headers: opts.headers, body: JSON.parse(opts.body) });
    const a = claudeAnswer();
    return new Response(JSON.stringify(a.json), { status: a.status });
  }
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

// ---------- the stuck call ("I'm stuck" → "Talk it through on the phone") ----------

test('the stuck call is announced only once its own agent is configured', async () => {
  delete process.env.CARTESIA_STUCK_AGENT_ID;
  let h = await (await fetch(base + '/api/health')).json();
  assert.deepEqual(h.features, []);
  const s = await signup('4155557777');
  const refused = await post('/api/call-now', { reason: 'stuck', task: 'Essay' }, s.token);
  assert.equal(refused.status, 400, 'no stuck call without the stuck agent');

  process.env.CARTESIA_STUCK_AGENT_ID = 'agent_stuck';
  try {
    h = await (await fetch(base + '/api/health')).json();
    assert.deepEqual(h.features, ['stuck-call']);
    assert.equal(h.cartesiaStuckAgent, true);
  } finally { delete process.env.CARTESIA_STUCK_AGENT_ID; }
});

test('a stuck call uses the stuck agent and names the task; the morning call is unchanged', async () => {
  process.env.CARTESIA_STUCK_AGENT_ID = 'agent_stuck';
  try {
    const s = await signup('4155558888');
    data.users[s.userId].paused = true; // said "stop" to morning calls
    cartesiaCalls.length = 0;
    const r = await post('/api/call-now', { reason: 'stuck', task: 'CS 188\nProject 2' }, s.token);
    assert.equal(r.status, 200);
    const vars = cartesiaCalls[0].body.outbound_calls[0].dynamic_variables;
    assert.equal(cartesiaCalls[0].body.agent_id, 'agent_stuck');
    assert.equal(vars.user_id, s.userId);
    assert.equal(vars.task, 'CS 188 Project 2');
    assert.match(vars.opening_line, /You pressed I'm stuck on CS 188 Project 2/);
    assert.equal(data.users[s.userId].paused, true, 'a stuck call does not turn morning calls back on');

    const morning = await post('/api/call-now', {}, s.token);
    assert.equal(morning.status, 200);
    assert.equal(cartesiaCalls[1].body.agent_id, 'agent_123');
    assert.equal(cartesiaCalls[1].body.outbound_calls[0].dynamic_variables.task, undefined);
  } finally { delete process.env.CARTESIA_STUCK_AGENT_ID; }
});

test('the first step from a stuck call reaches /api/today with its time', async () => {
  const a = await signup('4155559999');
  const before = await (await fetch(base + '/api/today', { headers: { Authorization: `Bearer ${a.token}` } })).json();
  assert.equal(before.firstStep, null);
  assert.equal(before.firstStepAt, null);

  const r = await post('/cartesia/save-plan', { user_id: a.userId, first_step: '  Open the spec and read only Question 1.  ' }, 'tool-secret');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Saved the first step: Open the spec and read only Question 1/);
  const after = await (await fetch(base + '/api/today', { headers: { Authorization: `Bearer ${a.token}` } })).json();
  assert.equal(after.firstStep, 'Open the spec and read only Question 1.');
  assert.ok(Date.parse(after.firstStepAt) > 0);
  assert.equal(after.focusTask, null, 'a first step does not replace the plan of the day');
});

test('a call-now body that is not JSON is refused', async () => {
  const s = await signup('4155550000');
  const r = await fetch(base + '/api/call-now', { method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
});

// ---------- Claude's first step for "I'm stuck" (the Mac app ships no API key) ----------

test('first step: Claude through the server, only for signed-in students, with a daily cap', async () => {
  const s = await signup('4155551212');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await post('/api/first-step', { task: 'Project 2' }, s.token)).status, 503, 'no key, no Claude');
  let h = await (await fetch(base + '/api/health')).json();
  assert.ok(!h.features.includes('first-step'));

  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    h = await (await fetch(base + '/api/health')).json();
    assert.ok(h.features.includes('first-step'));
    assert.equal((await post('/api/first-step', { task: 'Project 2' })).status, 401, 'needs a student token');

    claudeCalls.length = 0;
    const r = await post('/api/first-step', { task: 'Project 2', course: 'COMPSCI 188', attempt: 2, previous_step: 'Read the spec' }, s.token);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { step: 'Open search.py and read the comment above depthFirstSearch.', minutes: 5 });
    const sent = claudeCalls[0];
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test');
    assert.equal(sent.body.output_config, undefined, 'no structured outputs: their first-use latency could pass the app timeout');
    assert.match(sent.body.system, /Reply with JSON only/);
    assert.match(sent.body.messages[0].content, /Task: Project 2\nCourse: COMPSCI 188/);
    assert.match(sent.body.messages[0].content, /Retry 2\. This step was still too big: "Read the spec"/);

    assert.equal((await post('/api/first-step', { course: 'x' }, s.token)).status, 400, 'a task is required');
    claudeAnswer = () => ({ status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure! {"step":"Open search.py.","minutes":4}' }] } });
    assert.deepEqual(await (await post('/api/first-step', { task: 'Project 2' }, s.token)).json(), { step: 'Open search.py.', minutes: 4 }, 'text around the JSON is fine');
    claudeAnswer = () => ({ status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] } });
    assert.equal((await post('/api/first-step', { task: 'Project 2' }, s.token)).status, 502, 'a broken answer is an error, so the app falls back');
    claudeAnswer = () => ({ status: 529, json: {} });
    assert.equal((await post('/api/first-step', { task: 'Project 2' }, s.token)).status, 502);

    data.users[s.userId].steps = { date: data.users[s.userId].steps.date, count: 40 };
    assert.equal((await post('/api/first-step', { task: 'Project 2' }, s.token)).status, 429, 'daily cap per student');
  } finally { delete process.env.ANTHROPIC_API_KEY; }
});

test('claudeOpeningLine: uses Claude when it answers well, falls back to the fixed greeting otherwise', async () => {
  const { claudeOpeningLine, openingLine } = require('../index.js');
  const u = { id: 'x', timezone: 'America/Los_Angeles', tasks: [{ title: 'Problem Set 4', course: 'CS 188', dueAt: new Date(Date.now() + 864e5).toISOString() }] };
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(await claudeOpeningLine(u), openingLine(u), 'no key: fixed greeting');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    claudeAnswer = () => ({ status: 200, json: { content: [{ type: 'text', text: 'Good morning, this is Concentr8. Problem Set 4 is due tomorrow. Which task will you start, and when?' }] } });
    assert.match(await claudeOpeningLine(u), /Problem Set 4 is due tomorrow/);
    claudeAnswer = () => ({ status: 200, json: { content: [{ type: 'text', text: 'Hello there.' }] } });
    assert.equal(await claudeOpeningLine(u), openingLine(u), 'no question at the end: fixed greeting');
    claudeAnswer = () => ({ status: 500, json: {} });
    assert.equal(await claudeOpeningLine(u), openingLine(u), 'Claude error: fixed greeting');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});
