import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

interface ActivityView {
  label: string;
  app: string;
  title: string | null;
  url: string | null;
}

const { describeActivity } = require('../../renderer/activity-view.js') as {
  describeActivity(activity: { app: string; title: string | null; url: string | null }, verdict: { kind: string }): ActivityView;
};

test('activity view exposes the page title and complete URL', () => {
  const url = 'https://www.google.com/search?q=nfl+scores&sourceid=chrome';
  assert.deepEqual(
    describeActivity(
      { app: 'Google Chrome', title: 'nfl scores - Google Search', url },
      { kind: 'neutral' },
    ),
    {
      label: 'Unclear',
      app: 'Google Chrome',
      title: 'nfl scores - Google Search',
      url,
    },
  );
});

test('settings show the current app version', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(html, /id="app-version"/);
  assert.match(app, /Version \$\{state\.appVersion\}/);
});

test('stuck step explains the action and hides terminal fixed retries', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(html, /id="stuck-helper"/);
  assert.match(html, /id="stuck-smaller"[\s\S]*Still stuck/);
  assert.match(app, /Do this in your work\.[\s\S]*press I'm in\./);
  assert.match(app, /stuck-smaller'\)\.hidden = !step \|\| !step\.canRequestSmaller/);
});

test('Call me now remains discoverable and disconnected users are sent to recovery', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(html, /id="plan-empty"[\s\S]*id="call-now-empty"/);
  assert.match(html, /id="plan-set"[\s\S]*id="call-now"/);
  assert.match(html, /id="connected-block"[\s\S]*id="call-now-settings"/);
  assert.doesNotMatch(app, /\$\('call-now'\)\.hidden = !settings\.serverConnected/);
  assert.match(app, /if \(!state\.settings\.serverConnected\) \{[\s\S]*openSettings\(\);[\s\S]*recovery code/);
  assert.match(app, /\$\('call-now-settings'\)\.addEventListener/);
  assert.match(app, /requestCallNow\(\$\('call-now-status'\)\)/);
});

test('planning actions distinguish starting, scheduling, and editing', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(html, /id="intent-now"[\s\S]*>Now</);
  assert.match(html, /id="intent-later"[\s\S]*>Later</);
  assert.match(html, /id="change-plan"[\s\S]*>Edit plan</);
  assert.match(html, /id="cancel-plan"[\s\S]*>Cancel</);
  assert.match(app, /editing \? 'Save changes' : later \? 'Set plan' : 'Start focus'/);
  assert.match(app, /start-focus'\)\.textContent = [^\n]*\? 'Start early' : 'Start focus'/);

  const editBranch = app.match(/if \(editingPlan\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(editBranch, /c8\.setIntent\(task, time\)/);
  assert.match(editBranch, /return;/);
  assert.doesNotMatch(editBranch, /startFocus/);
});

test('forgetting the call connection warns that recovery is required', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(app, /\$\('server-disconnect'\)\.addEventListener[\s\S]*window\.confirm[\s\S]*recovery code[\s\S]*disconnectServer/);
  assert.match(app, /Saved locally\. Reconnect morning calls to update your call time\./);
});
