// "I'm stuck" end to end, without Electron:
// calm screen (no interventions) -> first step (Claude or fixed) -> timer -> check-in -> back to work,
// plus the optional stuck call and every fallback around it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CALL_TIMEOUT_MS, CALM_MS, Controller, countDriftStarts } from '../main/controller';
import { Store } from '../main/store';
import type { Platform } from '../services/platform';
import {
  buildStepPrompt,
  ClaudeStepProvider,
  createStepProvider,
  DEFAULT_STEP_MODEL,
  fallbackStep,
  parseStep,
  type StepProvider,
  suggestFirstStep,
} from '../services/stuck';
import type { DriftEvent } from '../shared/types';

const TZ = 'America/Los_Angeles';
const plainCrypto = { available: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A Mac that is always on YouTube, and records what Concentr8 tries to do about it. */
function youtubePlatform() {
  const actions: string[] = [];
  const platform: Platform = {
    supported: true,
    activity: async () => ({ app: 'Google Chrome', url: 'https://www.youtube.com/watch?v=x', title: 'YouTube', at: 0 }),
    redirect: async (_app, url) => (actions.push(`redirect ${url}`), true),
    closeTab: async () => (actions.push('close'), true),
    hideApp: async () => (actions.push('hide'), true),
  };
  return { platform, actions };
}

function setup(opts: { platform?: Platform; stepProvider?: StepProvider | null; withServer?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-stuck-'));
  const store = new Store(dir, plainCrypto);
  store.updateSettings({ demoMode: true, timezone: TZ, graceSeconds: 15 });
  if (opts.withServer) {
    store.serverApiKey = 'secret';
    store.updateSettings({ serverUrl: 'https://calls.example', serverConnected: true });
  }
  store.setTasks([
    {
      id: 'cs188-p2',
      title: 'Project 2: Multi-Agent Search',
      course: 'COMPSCI 188',
      dueAt: '2026-10-30T06:59:00Z',
      url: 'https://bcourses.berkeley.edu/courses/188/assignments/2',
      kind: 'assignment',
    },
  ]);
  let clock = Date.parse('2026-10-24T17:00:00Z');
  const notes: string[] = [];
  const opened: string[] = [];
  let shown = 0;
  const controller = new Controller({
    store,
    platform: opts.platform ?? youtubePlatform().platform,
    notify: (title) => notes.push(title),
    emit: () => {},
    showWindow: () => shown++,
    now: () => clock,
    stepProvider: opts.stepProvider ?? null,
    openUrl: (url) => opened.push(url),
  });
  const tick = () => (controller as unknown as { focusTick(): Promise<void> }).focusTick();
  return {
    controller,
    store,
    notes,
    opened,
    shown: () => shown,
    tick,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

// ---------- the step itself ----------

test('fixed steps get smaller with every retry and keep the task link', () => {
  const input = { task: 'Essay', course: null, taskUrl: 'https://x.test/a', attempt: 1, previousStep: null };
  const first = fallbackStep(input);
  const last = fallbackStep({ ...input, attempt: 9 });
  assert.equal(first.source, 'fallback');
  assert.equal(first.url, 'https://x.test/a');
  assert.equal(first.minutes, 5);
  assert.equal(last.minutes, 2);
  assert.notEqual(first.text, last.text);
});

test('step answers are validated and clamped', () => {
  assert.deepEqual(parseStep('{"step":"  Open the spec. ","minutes":30}'), { text: 'Open the spec.', minutes: 10 });
  assert.deepEqual(parseStep('{"step":"Read one line","minutes":0}'), { text: 'Read one line', minutes: 2 });
  assert.throws(() => parseStep('{"step":"","minutes":5}'));
  assert.throws(() => parseStep('not json'));
});

test('a retry tells Claude what was still too big', () => {
  const prompt = buildStepPrompt({ task: 'CS 188 Project 2', course: 'COMPSCI 188', taskUrl: null, attempt: 2, previousStep: 'Read the spec' });
  assert.match(prompt, /Task: CS 188 Project 2/);
  assert.match(prompt, /Course: COMPSCI 188/);
  assert.match(prompt, /still too big: "Read the spec"/);
});

test('Claude step request: Messages API, structured output, task in the prompt, no key or link in the body', async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"step":"Open the project spec and read only section 1.","minutes":5}' }] }),
    } as Response;
  }) as unknown as typeof fetch;

  const step = await suggestFirstStep(new ClaudeStepProvider('test-key', DEFAULT_STEP_MODEL, fetchImpl), {
    task: 'Project 2: Multi-Agent Search',
    course: 'COMPSCI 188',
    taskUrl: 'https://bcourses.berkeley.edu/courses/188/assignments/2',
    attempt: 1,
    previousStep: null,
  });

  assert.deepEqual(step, {
    text: 'Open the project spec and read only section 1.',
    minutes: 5,
    url: 'https://bcourses.berkeley.edu/courses/188/assignments/2',
    source: 'claude',
  });
  const [request] = requests;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.body.model, DEFAULT_STEP_MODEL);
  assert.equal(request.body.output_config.format.type, 'json_schema');
  assert.match(request.body.messages[0].content, /Multi-Agent Search/);
  const body = JSON.stringify(request.body);
  assert.ok(!body.includes('test-key'));
  assert.ok(!body.includes('bcourses.berkeley.edu'), 'the link stays local; Claude never chooses URLs');
});

test('Claude failures of every kind fall back to the fixed step', async () => {
  const replies: Array<{ status?: number; body?: unknown }> = [
    { status: 529, body: {} },
    { body: { stop_reason: 'refusal', content: [{ type: 'text', text: '{"step":"x","minutes":5}' }] } },
    { body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"step":"x"' }] } },
    { body: { content: [{ type: 'text', text: 'not json' }] } },
    { body: { content: [] } },
  ];
  for (const reply of replies) {
    const fetchImpl = (async () =>
      ({ ok: (reply.status ?? 200) < 300, status: reply.status ?? 200, json: async () => reply.body }) as Response) as unknown as typeof fetch;
    const step = await suggestFirstStep(new ClaudeStepProvider('k', DEFAULT_STEP_MODEL, fetchImpl), {
      task: 'Essay',
      course: null,
      taskUrl: null,
      attempt: 1,
      previousStep: null,
    });
    assert.equal(step.source, 'fallback');
  }
});

test('the step provider needs ANTHROPIC_API_KEY', () => {
  assert.equal(createStepProvider({} as NodeJS.ProcessEnv), null);
  assert.equal(createStepProvider({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)?.model, DEFAULT_STEP_MODEL);
});

// ---------- the whole flow ----------

test('stuck flow: calm screen pauses interventions, then step, timer, check-in, back to work', async () => {
  const { platform, actions } = youtubePlatform();
  const { controller, store, notes, opened, shown, tick, advance } = setup({ platform });
  controller.startFocus('Project 2: Multi-Agent Search');

  assert.equal(controller.imStuck().ok, true);
  assert.equal(controller.getState().stuck?.phase, 'calm');

  // YouTube on screen during the calm minute: no warning, nothing closed.
  await tick();
  advance(30_000);
  await tick();
  assert.ok(!notes.some((n) => n.startsWith('Back to')));
  assert.deepEqual(actions, []);

  // Calm screen ends by its own timer.
  advance(CALM_MS);
  await tick();
  await flush();
  let stuck = controller.getState().stuck!;
  assert.equal(stuck.phase, 'step');
  assert.equal(stuck.step?.source, 'fallback');
  assert.equal(stuck.attempts, 1);
  assert.deepEqual(opened, ['https://bcourses.berkeley.edu/courses/188/assignments/2'], 'the assignment opens once');
  assert.ok(shown() >= 1);

  // Timer runs out: check-in.
  advance(5 * 60_000);
  await (controller as unknown as { stuckTick(): Promise<void> }).stuckTick();
  assert.equal(controller.getState().stuck?.phase, 'checkin');
  assert.ok(notes.includes('5 minutes are up'));

  // Still stuck: a smaller step, the page is not opened again.
  const firstText = stuck.step!.text;
  controller.stuckAnswer('smaller');
  await flush();
  stuck = controller.getState().stuck!;
  assert.equal(stuck.phase, 'step');
  assert.equal(stuck.attempts, 2);
  assert.notEqual(stuck.step?.text, firstText);
  assert.equal(opened.length, 1);

  controller.stuckAnswer('started');
  assert.equal(controller.getState().stuck, null);

  controller.stopFocus();
  assert.equal(store.history[0].stuck, 1);
  assert.equal(store.history[0].gotGoing, 1);
});

test('"I\'m ready" ends the calm screen early, and Claude\'s step is used when configured', async () => {
  const provider: StepProvider = {
    name: 'fake-claude',
    model: 'fake',
    suggest: async () => ({ text: 'Open the spec and read only section 1.', minutes: 4 }),
  };
  const { controller, advance } = setup({ stepProvider: provider });
  controller.startFocus('Project 2: Multi-Agent Search');
  controller.imStuck();
  advance(5_000);
  controller.calmDone();
  await flush();
  const stuck = controller.getState().stuck!;
  assert.equal(stuck.step?.source, 'claude');
  assert.equal(stuck.step?.text, 'Open the spec and read only section 1.');
  assert.equal(Date.parse(stuck.phaseEndsAt!) - (Date.parse(stuck.startedAt) + 5_000), 4 * 60_000);
});

test('break and cancel end the episode; ending the session mid-episode is recorded', async () => {
  const { controller, store } = setup();
  controller.startFocus('Essay');
  controller.imStuck();
  controller.calmDone();
  await flush();
  controller.stuckAnswer('break');
  assert.equal(controller.getState().stuck, null);
  assert.ok(controller.getState().session?.breakUntil, 'a real break starts');

  controller.imStuck();
  controller.cancelStuck();
  controller.imStuck();
  controller.stopFocus();
  assert.equal(store.history[0].stuck, 3);
  assert.equal(store.history[0].gotGoing, 0);
  assert.equal(controller.getState().stuck, null);
});

test('a double click on "Still stuck" asks for one smaller step, not two', async () => {
  const asked: Array<[number, string | null]> = [];
  const releases: Array<() => void> = [];
  const provider: StepProvider = {
    name: 'slow',
    model: 'slow',
    suggest: (input) =>
      new Promise((resolve) => {
        asked.push([input.attempt, input.previousStep]);
        releases.push(() => resolve({ text: `step ${input.attempt}`, minutes: 5 }));
      }),
  };
  const { controller } = setup({ stepProvider: provider });
  controller.startFocus('Essay');
  controller.imStuck();
  controller.calmDone();
  releases[0]();
  await flush();
  controller.stuckAnswer('smaller');
  controller.stuckAnswer('smaller');
  releases[1]?.();
  await flush();
  assert.deepEqual(asked, [
    [1, null],
    [2, 'step 1'],
  ]);
  assert.equal(controller.getState().stuck?.step?.text, 'step 2');
});

test('a step that arrives after the episode ended is ignored', async () => {
  const releases: Array<() => void> = [];
  const provider: StepProvider = {
    name: 'slow',
    model: 'slow',
    suggest: () => new Promise((resolve) => releases.push(() => resolve({ text: 'late', minutes: 5 }))),
  };
  const { controller, opened } = setup({ stepProvider: provider });
  controller.startFocus('Project 2: Multi-Agent Search');
  controller.imStuck();
  controller.calmDone();
  controller.cancelStuck();
  controller.imStuck(); // a new episode, still calm
  releases[0]();
  await flush();
  const stuck = controller.getState().stuck!;
  assert.equal(stuck.phase, 'calm');
  assert.equal(stuck.step, null);
  assert.deepEqual(opened, []);
});

test('no "Rough start?" offer right after a stuck episode', async () => {
  const quiet: Platform = { supported: true, activity: async () => null, redirect: async () => false, closeTab: async () => false, hideApp: async () => false };
  const { controller, notes, tick, now, advance } = setup({ platform: quiet });
  controller.startFocus('Essay');
  const drifts = controller.getState().session!.drifts;
  const drift = (target: string) => drifts.push({ at: new Date(now()).toISOString(), target, action: 'nudged' });
  drift('youtube.com');
  drift('reddit.com');
  controller.imStuck();
  controller.calmDone();
  await flush();
  drift('instagram.com'); // third drift during the step
  controller.stuckAnswer('started');
  advance(3_000);
  await tick();
  assert.ok(!notes.includes('Rough start?'));
});

test('stuck needs a running session', () => {
  const { controller } = setup();
  assert.equal(controller.imStuck().ok, false);
});

test('repeated drifting offers "I\'m stuck" once, without starting it', async () => {
  const quiet: Platform = { supported: true, activity: async () => null, redirect: async () => false, closeTab: async () => false, hideApp: async () => false };
  const { controller, notes, tick, now, advance } = setup({ platform: quiet });
  controller.startFocus('Essay');
  const drifts = controller.getState().session!.drifts;
  for (const target of ['youtube.com', 'reddit.com', 'instagram.com']) {
    drifts.push({ at: new Date(now()).toISOString(), target, action: 'nudged' });
    advance(60_000);
  }
  await tick();
  await tick();
  assert.equal(notes.filter((n) => n === 'Rough start?').length, 1);
  assert.equal(controller.getState().stuck, null);
});

test('a warning followed by its block counts as one drift', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 24, 17, m)).toISOString();
  const drifts: DriftEvent[] = [
    { at: at(0), target: 'youtube.com', action: 'nudged' },
    { at: at(0), target: 'youtube.com', action: 'blocked' },
    { at: at(2), target: 'youtube.com', action: 'blocked' }, // repeat within the window: no warning first
    { at: at(3), target: 'reddit.com', action: 'returned' },
  ];
  assert.equal(countDriftStarts(drifts, 0), 2);
  assert.equal(countDriftStarts(drifts, Date.UTC(2026, 9, 24, 17, 1)), 1);
});

// ---------- the optional phone call ----------

function mockServer(
  t: { after(fn: () => void): void },
  opts: { features?: string[]; failCall?: boolean; existingStep?: { text: string; at: string } },
) {
  const calls: Array<{ path: string; body: unknown }> = [];
  let todayStep: { firstStep: string; firstStepAt: string } | null = opts.existingStep
    ? { firstStep: opts.existingStep.text, firstStepAt: opts.existingStep.at }
    : null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace('https://calls.example', '');
    calls.push({ path: `${init?.method || 'GET'} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let body: unknown = { ok: true };
    if (url === '/api/health') body = { ok: true, ...(opts.features ? { features: opts.features } : {}) };
    if (url === '/api/today') {
      body = { date: '2026-10-24', focusTask: null, startTime: null, lastCallAt: null, lastCallStatus: null, ...(todayStep ?? {}) };
    }
    if (url === '/api/call-now') {
      if (opts.failCall) return new Response(JSON.stringify({ error: 'Cartesia: the call did not start' }), { status: 502 });
      body = { ok: true, callSid: 'call-1' };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return { calls, agree: (text: string, at: number) => (todayStep = { firstStep: text, firstStepAt: new Date(at).toISOString() }) };
}

test('stuck call: offered only when the server supports it, and the agreed step comes back from the call', async (t) => {
  const server = mockServer(t, { features: ['stuck-call'] });
  const youtube = youtubePlatform();
  const { controller, advance, now, notes, tick } = setup({ withServer: true, platform: youtube.platform });
  controller.startFocus('Project 2: Multi-Agent Search');
  controller.imStuck();
  await flush();
  assert.equal(controller.getState().stuck?.callAvailable, true);

  controller.calmDone();
  await flush();
  assert.equal((await controller.stuckCall()).ok, true);
  assert.equal(controller.getState().stuck?.phase, 'call');
  const call = server.calls.find((c) => c.path === 'POST /api/call-now');
  assert.deepEqual(call?.body, { reason: 'stuck', task: 'Project 2: Multi-Agent Search' });

  // Interventions stay paused during the call: YouTube is on screen, nothing is warned or closed.
  advance(6_000);
  await tick();
  advance(20_000);
  await tick();
  assert.equal(controller.getState().stuck?.phase, 'call', 'no step yet');
  assert.ok(!notes.some((n) => n.startsWith('Back to')));
  assert.deepEqual(youtube.actions, []);

  // A second call can't be placed while one is running.
  assert.equal((await controller.stuckCall()).ok, false);
  assert.equal(server.calls.filter((c) => c.path === 'POST /api/call-now').length, 1);

  server.agree('Open search.py and read the comment above depthFirstSearch.', now());
  advance(6_000);
  await controller.stuckTick();
  const stuck = controller.getState().stuck!;
  assert.equal(stuck.phase, 'step');
  assert.equal(stuck.step?.source, 'call');
  assert.equal(stuck.step?.text, 'Open search.py and read the comment above depthFirstSearch.');
});

test('stuck call ignores the step from an earlier call and trusts server time, not the Mac clock', async (t) => {
  // The server still holds yesterday's step, and its clock runs 10 minutes behind this Mac.
  const server = mockServer(t, { features: ['stuck-call'], existingStep: { text: 'Old step', at: '2026-10-23T16:00:00Z' } });
  const { controller, advance, now } = setup({ withServer: true });
  controller.startFocus('Essay');
  controller.imStuck();
  await flush();
  controller.calmDone();
  await flush();
  await controller.stuckCall();

  advance(6_000);
  await controller.stuckTick();
  assert.equal(controller.getState().stuck?.phase, 'call', 'the old step is not taken');

  server.agree('Write the first sentence of the intro.', now() - 10 * 60_000);
  advance(6_000);
  await controller.stuckTick();
  assert.equal(controller.getState().stuck?.step?.text, 'Write the first sentence of the intro.');
});

test('a failed call request goes back to the step with a fresh timer', async (t) => {
  mockServer(t, { features: ['stuck-call'], failCall: true });
  const { controller, now } = setup({ withServer: true });
  controller.startFocus('Essay');
  controller.imStuck();
  await flush();
  controller.calmDone();
  await flush();
  const result = await controller.stuckCall();
  assert.equal(result.ok, false);
  assert.match(result.error!, /did not start/);
  const stuck = controller.getState().stuck!;
  assert.equal(stuck.phase, 'step');
  assert.equal(Date.parse(stuck.phaseEndsAt!), now() + stuck.step!.minutes * 60_000);
});

test('no call during the calm screen or while the first step is still loading', async (t) => {
  const server = mockServer(t, { features: ['stuck-call'] });
  let release: (v: { text: string; minutes: number }) => void = () => {};
  const slow: StepProvider = { name: 'slow', model: 'slow', suggest: () => new Promise((resolve) => (release = resolve)) };
  const { controller } = setup({ withServer: true, stepProvider: slow });
  controller.startFocus('Essay');
  controller.imStuck();
  await flush();
  assert.equal((await controller.stuckCall()).ok, false, 'calm');
  controller.calmDone();
  assert.equal((await controller.stuckCall()).ok, false, 'step still loading');
  assert.ok(!server.calls.some((c) => c.path === 'POST /api/call-now'));
  release({ text: 'Read the prompt once.', minutes: 5 });
  await flush();
  assert.equal(controller.getState().stuck?.step?.text, 'Read the prompt once.');
});

test('stuck call timeout falls back to the prepared step and restarts its timer', async (t) => {
  mockServer(t, { features: ['stuck-call'] });
  const { controller, advance, now } = setup({ withServer: true });
  controller.startFocus('Essay');
  controller.imStuck();
  await flush();
  controller.calmDone();
  await flush();
  const prepared = controller.getState().stuck!.step!.text;
  await controller.stuckCall();

  advance(CALL_TIMEOUT_MS + 1_000);
  await controller.stuckTick();
  const stuck = controller.getState().stuck!;
  assert.equal(stuck.phase, 'step');
  assert.equal(stuck.step?.text, prepared);
  assert.equal(Date.parse(stuck.phaseEndsAt!), now() + stuck.step!.minutes * 60_000);
});

test('an older call server without stuck support never gets a stuck call', async (t) => {
  const server = mockServer(t, {});
  const { controller } = setup({ withServer: true });
  controller.startFocus('Essay');
  controller.imStuck();
  await flush();
  assert.equal(controller.getState().stuck?.callAvailable, false);
  controller.calmDone();
  await flush();
  assert.equal((await controller.stuckCall()).ok, false);
  assert.ok(!server.calls.some((c) => c.path === 'POST /api/call-now'));
});
