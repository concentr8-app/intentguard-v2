// Run with: npm test   (compiles, then uses Node's built-in test runner)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Activity, Task } from '../shared/types';
import { classify, DEFAULT_RULES, matchesDomainRule } from '../services/rules';
import { localDate, localHHMM, parseSpokenTime } from '../services/time';
import { matchTask } from '../services/match';
import { isFeedUrl, nextLink, normalizePlannerItems, parseIcsTasks } from '../services/canvas';
import { FocusEngine } from '../services/focus';
import type { Platform } from '../services/platform';

const TZ = 'America/Los_Angeles';
const act = (app: string, url: string | null = null, title: string | null = null): Activity => ({ app, url, title, at: 0 });

test('domain rules match subdomains and path prefixes', () => {
  assert.ok(matchesDomainRule('youtube.com', 'm.youtube.com', '/'));
  assert.ok(matchesDomainRule('linkedin.com/feed', 'linkedin.com', '/feed/update'));
  assert.ok(!matchesDomainRule('linkedin.com/feed', 'linkedin.com', '/jobs'));
  assert.ok(!matchesDomainRule('x.com', 'netflix.com', '/')); // no accidental suffix match
});

test('classify: distraction, focus, neutral', () => {
  assert.equal(classify(act('Google Chrome', 'https://www.youtube.com/watch?v=1'), DEFAULT_RULES).kind, 'distraction');
  assert.equal(classify(act('Google Chrome', 'https://bcourses.berkeley.edu/courses/1'), DEFAULT_RULES).kind, 'focus');
  assert.equal(classify(act('Safari', 'https://en.wikipedia.org/wiki/Markov_chain'), DEFAULT_RULES).kind, 'neutral');
  assert.equal(classify(act('Discord'), DEFAULT_RULES).kind, 'distraction');
  assert.equal(classify(act('Visual Studio Code'), DEFAULT_RULES).kind, 'focus');
});

test('classify: Firefox via window title', () => {
  assert.equal(classify(act('Firefox', null, 'Funny cats - YouTube — Mozilla Firefox'), DEFAULT_RULES).kind, 'distraction');
  assert.equal(classify(act('Firefox', null, 'Project 2 - bCourses — Mozilla Firefox'), DEFAULT_RULES).kind, 'neutral');
});

test('timezone helpers', () => {
  const d = new Date('2026-10-24T15:05:00Z'); // 08:05 in Berkeley (PDT)
  assert.equal(localDate(d, TZ), '2026-10-24');
  assert.equal(localHHMM(d, TZ), '08:05');
});

test('parseSpokenTime understands common answers', () => {
  const now = new Date('2026-10-24T15:05:00Z'); // 08:05 PDT
  const hhmm = (s: string) => {
    const r = parseSpokenTime(s, now, TZ);
    return r ? localHHMM(r, TZ) : null;
  };
  assert.equal(hhmm('9 a.m.'), '09:00');
  assert.equal(hhmm('nine thirty'), '09:30');
  assert.equal(hhmm('at 10:15'), '10:15');
  assert.equal(hhmm('two'), '14:00'); // 2am already passed -> 2pm
  assert.equal(hhmm('half past nine'), '09:30');
  assert.equal(hhmm('noon'), '12:00');
  assert.equal(hhmm('in 20 minutes'), '08:25');
  assert.equal(hhmm('right now'), '08:05');
  assert.equal(hhmm('8'), '08:00'); // said at 8:05, still means this morning
  assert.equal(hhmm('after lunch I guess'), null);
});

const tasks: Task[] = [
  { id: '1', title: 'Project 2: Multi-Agent Search', course: 'COMPSCI 188', dueAt: null, url: 'https://c/1', kind: 'assignment' },
  { id: '2', title: 'Problem Set 6', course: 'STAT 134', dueAt: null, url: 'https://c/2', kind: 'assignment' },
];

test('matchTask links speech to a Canvas task', () => {
  assert.equal(matchTask('I will start with the CS188 project', tasks)?.id, '1');
  assert.equal(matchTask('stat problem set', tasks)?.id, '2');
  assert.equal(matchTask('laundry', tasks), null);
});

test('Canvas: pagination and planner normalization', () => {
  assert.equal(
    nextLink('<https://x/api?page=1>; rel="current", <https://x/api?page=2>; rel="next"'),
    'https://x/api?page=2',
  );
  const now = new Date('2026-10-24T15:00:00Z');
  const out = normalizePlannerItems(
    [
      { plannable_id: 1, plannable_type: 'assignment', course_id: 7, html_url: '/courses/7/assignments/1', plannable: { title: 'B', due_at: '2026-10-27T06:59:00Z' }, submissions: { submitted: false } },
      { plannable_id: 2, plannable_type: 'assignment', course_id: 7, plannable: { title: 'Done', due_at: '2026-10-26T06:59:00Z' }, submissions: { submitted: true } },
      { plannable_id: 3, plannable_type: 'announcement', plannable: { title: 'News' } },
      { plannable_id: 4, plannable_type: 'quiz', context_name: 'DATA 100', plannable: { title: 'A', due_at: '2026-10-25T06:59:00Z' } },
    ],
    new Map([[7, 'COMPSCI 188']]),
    'https://bcourses.berkeley.edu',
    now,
  );
  assert.deepEqual(out.map((t) => t.title), ['A', 'B']);
  assert.equal(out[1].url, 'https://bcourses.berkeley.edu/courses/7/assignments/1');
  assert.equal(out[1].course, 'COMPSCI 188');
});

test('Canvas: calendar feed fallback', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-assignment-101',
    'DTSTART:20261025T065900Z',
    'SUMMARY:Project 2: Multi-Agent Search [COMPSCI 188 - LEC 001]',
    'URL:https://bcourses.berkeley.edu/courses/7/assignments/101',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-calendar-event-55',
    'DTSTART:20261025T170000Z',
    'SUMMARY:Office hours [COMPSCI 188]',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-assignment-102',
    'DTSTART;VALUE=DATE:20261027',
    'SUMMARY:Reading response\\, week 9 [ENGIN 183E]',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-assignment-90',
    'DTSTART:20260901T065900Z',
    'SUMMARY:Old homework [STAT 134]',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const out = parseIcsTasks(ics, TZ, 14, new Date('2026-10-24T15:00:00Z'));
  assert.deepEqual(out.map((t) => t.title), ['Project 2: Multi-Agent Search', 'Reading response, week 9']);
  assert.equal(out[0].course, 'COMPSCI 188 - LEC 001');
  assert.equal(localHHMM(new Date(out[1].dueAt!), TZ), '23:59'); // all-day -> end of day in Berkeley
  assert.ok(isFeedUrl('https://bcourses.berkeley.edu/feeds/calendars/user_abc.ics'));
  assert.ok(!isFeedUrl('7~abcdefTOKEN'));
});

function fakePlatform(screen: { current: Activity }) {
  const calls: string[] = [];
  const platform: Platform = {
    supported: true,
    activity: async () => screen.current,
    redirect: async (_app, url) => {
      calls.push(`redirect ${url}`);
      return true;
    },
    closeTab: async () => {
      calls.push('close');
      return true;
    },
    hideApp: async (app) => {
      calls.push(`hide ${app}`);
      return true;
    },
  };
  return { platform, calls };
}

test('FocusEngine: nudge, then block and restore the last work tab', async () => {
  let clock = 1_000_000;
  const screen = { current: act('Google Chrome', 'https://bcourses.berkeley.edu/courses/7') };
  const { platform, calls } = fakePlatform(screen);
  const notes: string[] = [];
  const engine = new FocusEngine({
    platform,
    notify: (t) => notes.push(t),
    onChange: () => {},
    rules: () => DEFAULT_RULES,
    graceSeconds: () => 15,
    fallbackUrl: () => null,
    now: () => clock,
  });
  engine.start('CS188 project', null, 50);

  await engine.tick(); // on Canvas -> remembered as last relevant tab
  screen.current = act('Google Chrome', 'https://www.youtube.com/');
  clock += 3_000;
  await engine.tick(); // drift starts -> nudge
  assert.equal(calls.length, 0);
  assert.match(notes.at(-1)!, /Back to: CS188 project/);

  clock += 16_000;
  await engine.tick(); // grace over -> block
  assert.deepEqual(calls, ['redirect https://bcourses.berkeley.edu/courses/7']);

  clock += 3_000;
  await engine.tick(); // reopened within 2 min -> blocked again without a warning
  assert.equal(calls.length, 2);

  screen.current = act('Discord');
  clock += 3_000;
  await engine.tick();
  clock += 16_000;
  await engine.tick();
  assert.equal(calls.at(-1), 'hide Discord');

  const summary = engine.stop();
  assert.equal(summary?.blocks, 3);
});

test('FocusEngine: breaks pause blocking, sessions end on time', async () => {
  let clock = 0;
  const screen = { current: act('Google Chrome', 'https://reddit.com/r/berkeley') };
  const { platform, calls } = fakePlatform(screen);
  const engine = new FocusEngine({
    platform,
    notify: () => {},
    onChange: () => {},
    rules: () => DEFAULT_RULES,
    graceSeconds: () => 0,
    fallbackUrl: () => null,
    now: () => clock,
  });
  engine.start('Reading', null, 25);
  engine.takeBreak(5);
  await engine.tick();
  assert.equal(calls.length, 0);
  clock += 6 * 60_000; // break over, strict mode (grace 0) -> immediate block
  await engine.tick();
  assert.deepEqual(calls, ['close']); // no work tab known -> close the tab
  clock += 30 * 60_000;
  const summary = await engine.tick();
  assert.equal(summary?.task, 'Reading');
  assert.equal(engine.session, null);
});
