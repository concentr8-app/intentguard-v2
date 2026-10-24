// End-to-end check of the daily loop without Electron:
// phone answer on the server -> intent in the app -> focus session starts at the promised time.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../main/controller';
import { Store } from '../main/store';
import { createNullPlatform } from '../services/platform';
import { localHHMM } from '../services/time';

const TZ = 'America/Los_Angeles';
const plainCrypto = { available: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };

function setup(withServer: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c8-'));
  const store = new Store(dir, plainCrypto);
  store.updateSettings({ demoMode: true, timezone: TZ, callTime: '08:00' });
  if (withServer) {
    store.serverApiKey = 'secret';
    store.updateSettings({ serverUrl: 'https://calls.example', serverConnected: true });
  }
  let clock = Date.parse('2026-10-24T15:00:00Z'); // 08:00 in Berkeley
  const notes: string[] = [];
  let shown = 0;
  const controller = new Controller({
    store,
    platform: createNullPlatform(),
    notify: (title) => notes.push(title),
    emit: () => {},
    showWindow: () => shown++,
    now: () => clock,
  });
  return {
    controller,
    store,
    notes,
    shown: () => shown,
    setClock: (iso: string) => (clock = Date.parse(iso)),
  };
}

test('call answer becomes a focus session at the promised time', async (t) => {
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method || 'GET'} ${url.replace('https://calls.example', '')}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    const body = url.endsWith('/api/today')
      ? { date: '2026-10-24', focusTask: 'the CS 188 project', startTime: '8:30 a.m.', lastCallAt: '2026-10-24T15:01:00Z', lastCallStatus: 'completed' }
      : { ok: true, count: 5 };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const { controller, store, notes, setClock } = setup(true);
  await controller.syncCanvas();
  assert.ok(requests.includes('POST /api/tasks'), 'tasks are pushed to the call server');

  setClock('2026-10-24T15:05:00Z');
  await controller.pollServer();
  const today = controller.today;
  assert.equal(today.focusTask, 'the CS 188 project');
  assert.equal(today.source, 'call');
  assert.equal(localHHMM(new Date(today.startAt!), TZ), '08:30');
  assert.ok(notes.includes('Locked in from your call'));

  setClock('2026-10-24T15:10:00Z'); // 08:10, too early
  controller.clockTick();
  assert.equal(controller.getState().session, null);

  setClock('2026-10-24T15:30:30Z'); // 08:30:30
  controller.clockTick();
  const session = controller.getState().session;
  assert.equal(session?.task, 'the CS 188 project');
  assert.equal(session?.taskUrl, store.tasks.find((t) => t.course === 'COMPSCI 188')?.url);

  controller.stopFocus();
  controller.clockTick(); // must not restart the same day
  assert.equal(controller.getState().session, null);
  assert.equal(store.history.length, 1);
});

test('without a call server the app asks in the morning itself', () => {
  const { controller, notes, shown } = setup(false);
  controller.clockTick();
  assert.ok(notes.includes('Good morning ☀️'));
  assert.equal(shown(), 1);
  controller.clockTick(); // only once a day
  assert.equal(shown(), 1);
});

test('typed intent with a start time also auto-starts', () => {
  const { controller, setClock } = setup(false);
  controller.setIntent('Problem set 6', 'in 20 minutes');
  setClock('2026-10-24T15:21:00Z');
  controller.clockTick();
  assert.equal(controller.getState().session?.task, 'Problem set 6');
});
