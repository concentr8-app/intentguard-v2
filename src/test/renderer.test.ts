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

test('connected call settings keep Call me now available after a completed call', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

  assert.match(html, /id="connected-block"[\s\S]*id="call-now-settings"/);
  assert.match(app, /\$\('call-now-settings'\)\.addEventListener/);
  assert.match(app, /requestCallNow\(\$\('call-now-status'\)\)/);
});
