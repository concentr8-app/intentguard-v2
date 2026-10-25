import assert from 'node:assert/strict';
import test from 'node:test';
import { CachedSemanticClassifier, classifyWithSemantic } from '../services/semantic';
import { ServerSemanticProvider, usefulLocation } from '../services/semanticServer';
import { DEFAULT_RULES } from '../services/rules';
import type { ActivityContext } from '../shared/types';

const nfl: ActivityContext = {
  intent: 'BISP LGBTQ+ Mixer | October 24',
  activity: { app: 'Firefox', title: 'nfl league - Google Suche', url: 'https://www.google.com/search?q=nfl+league&udm=14&ei=SECRET', at: 0 },
};

test('usefulLocation keeps host, path and the search, nothing else', () => {
  assert.equal(usefulLocation('https://www.google.com/search?q=nfl+league&udm=14&ei=SECRET'), 'www.google.com/search; query: nfl league');
  assert.equal(usefulLocation('https://bcourses.berkeley.edu/courses/1/assignments/2?token=x'), 'bcourses.berkeley.edu/courses/1/assignments/2');
  assert.equal(usefulLocation(null), '');
});

test('an NFL search during an unrelated session becomes a distraction when Claude is sure', async () => {
  const sent: unknown[] = [];
  const server = { relevance: async (input: unknown) => (sent.push(input), { relevance: 'unrelated', confidence: 0.95, reason: 'An NFL search is not part of this.' }) };
  const semantic = new CachedSemanticClassifier(new ServerSemanticProvider(() => server));
  const verdict = await classifyWithSemantic(nfl, DEFAULT_RULES, semantic);
  assert.equal(verdict.kind, 'distraction');
  assert.deepEqual(sent[0], { intent: 'BISP LGBTQ+ Mixer | October 24', app: 'Firefox', title: 'nfl league - Google Suche', location: 'www.google.com/search; query: nfl league' });
  await classifyWithSemantic(nfl, DEFAULT_RULES, semantic);
  assert.equal(sent.length, 1, 'asked once per page and intent');
});

test('no server, an unsure answer or an error keep the page neutral', async () => {
  const none = new CachedSemanticClassifier(new ServerSemanticProvider(() => null));
  assert.equal((await classifyWithSemantic(nfl, DEFAULT_RULES, none)).kind, 'neutral');
  const unsure = new CachedSemanticClassifier(new ServerSemanticProvider(() => ({ relevance: async () => ({ relevance: 'unrelated', confidence: 0.6, reason: '' }) })));
  assert.equal((await classifyWithSemantic(nfl, DEFAULT_RULES, unsure)).kind, 'neutral');
  const failing = new CachedSemanticClassifier(new ServerSemanticProvider(() => ({ relevance: async () => { throw new Error('502'); } })));
  assert.equal((await classifyWithSemantic(nfl, DEFAULT_RULES, failing)).kind, 'neutral');
});
