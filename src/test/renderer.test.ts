import assert from 'node:assert/strict';
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
