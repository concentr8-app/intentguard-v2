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

  assert.match(html, /id="plan-set"[\s\S]*id="call-now"/);
  assert.match(html, /id="connected-block"[\s\S]*id="call-now-settings"/);
  assert.doesNotMatch(app, /\$\('call-now'\)\.hidden = !settings\.serverConnected/);
  assert.match(app, /if \(!state\.settings\.serverConnected\) \{[\s\S]*openSettings\(\);[\s\S]*recovery code/);
  assert.match(app, /\$\('call-now-settings'\)\.addEventListener/);
  assert.match(app, /requestCallNow\(\$\('call-now-status'\)\)/);
});

test('forgetting the call connection warns that recovery is required', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(app, /\$\('server-disconnect'\)\.addEventListener[\s\S]*window\.confirm[\s\S]*recovery code[\s\S]*disconnectServer/);
  assert.match(app, /Saved locally\. Reconnect morning calls to update your call time\./);
});
