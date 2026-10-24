import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroqSemanticProvider, DEFAULT_GROQ_MODEL } from '../services/groq';
import { DEFAULT_RULES } from '../services/rules';
import {
  CachedSemanticClassifier,
  classifyWithSemantic,
  type SemanticProvider,
  type SemanticResult,
} from '../services/semantic';
import type { ActivityContext } from '../shared/types';

const context = (
  intent: string,
  url: string | null,
  title: string | null,
  app = 'Google Chrome',
): ActivityContext => ({ activity: { app, url, title, at: 0 }, intent });

function mockProvider(result: SemanticResult | Error) {
  let calls = 0;
  const provider: SemanticProvider = {
    name: 'mock',
    model: 'mock-small',
    async classifySemantic() {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { provider, calls: () => calls };
}

test('deterministic focus and distraction make zero semantic calls', async () => {
  const mock = mockProvider({ relevance: 'unrelated', confidence: 1, reason: 'unused' });
  const semantic = new CachedSemanticClassifier(mock.provider);

  const focus = await classifyWithSemantic(
    context('Finish Math 185 HW8', 'https://bcourses.berkeley.edu/courses/1/assignments/8', 'HW8'),
    DEFAULT_RULES,
    semantic,
  );
  const distraction = await classifyWithSemantic(
    context('Build Concentr8', 'https://www.instagram.com/', 'Instagram'),
    DEFAULT_RULES,
    semantic,
  );

  assert.equal(focus.kind, 'focus');
  assert.equal(distraction.kind, 'distraction');
  assert.equal(mock.calls(), 0);
});

test('deterministic neutral invokes semantic classification once, then uses the cache', async () => {
  const mock = mockProvider({ relevance: 'uncertain', confidence: 0.9, reason: 'Not enough context' });
  const logs: string[] = [];
  const semantic = new CachedSemanticClassifier(mock.provider, (message) => logs.push(message));
  const activity = context('Finish Math 185 HW8', 'https://www.google.com/search?q=nfl+scores', 'nfl scores');

  await classifyWithSemantic(activity, DEFAULT_RULES, semantic);
  await classifyWithSemantic(activity, DEFAULT_RULES, semantic);

  assert.equal(mock.calls(), 1);
  assert.ok(logs.some((message) => message.includes('API call provider=mock model=mock-small')));
  assert.ok(logs.includes('[semantic] cache hit'));
});

test('the same page with a different intent can be classified again', async () => {
  const mock = mockProvider({ relevance: 'relevant', confidence: 0.95, reason: 'Matches the intent' });
  const semantic = new CachedSemanticClassifier(mock.provider);
  const url = 'https://example.com/article';

  await classifyWithSemantic(context('Finish Math 185 HW8', url, 'Maximum Modulus Principle'), DEFAULT_RULES, semantic);
  await classifyWithSemantic(context('Plan a biology lab', url, 'Maximum Modulus Principle'), DEFAULT_RULES, semantic);

  assert.equal(mock.calls(), 2);
});

test('high-confidence semantic results map to focus or distraction', async () => {
  const relevant = new CachedSemanticClassifier(
    mockProvider({ relevance: 'relevant', confidence: 0.9, reason: 'Explains the assigned theorem' }).provider,
  );
  const unrelated = new CachedSemanticClassifier(
    mockProvider({ relevance: 'unrelated', confidence: 0.92, reason: 'Sports scores do not help with the homework' }).provider,
  );
  const neutral = context('Finish Math 185 HW8', 'https://example.com/', 'A page without lexical overlap');

  assert.equal((await classifyWithSemantic(neutral, DEFAULT_RULES, relevant)).kind, 'focus');
  assert.equal((await classifyWithSemantic(neutral, DEFAULT_RULES, unrelated)).kind, 'distraction');
});

test('uncertain and low-confidence semantic results stay neutral', async () => {
  const uncertain = new CachedSemanticClassifier(
    mockProvider({ relevance: 'uncertain', confidence: 0.99, reason: 'Insufficient context' }).provider,
  );
  const lowConfidence = new CachedSemanticClassifier(
    mockProvider({ relevance: 'unrelated', confidence: 0.6, reason: 'Maybe unrelated' }).provider,
  );
  const activity = context('Finish Math 185 HW8', 'https://example.com/', 'Generic page');

  assert.equal((await classifyWithSemantic(activity, DEFAULT_RULES, uncertain)).kind, 'neutral');
  assert.equal((await classifyWithSemantic(activity, DEFAULT_RULES, lowConfidence)).kind, 'neutral');
});

test('provider failure safely returns neutral', async () => {
  const semantic = new CachedSemanticClassifier(mockProvider(new Error('network down')).provider);
  const verdict = await classifyWithSemantic(
    context('Finish Math 185 HW8', 'https://example.com/', 'Generic page'),
    DEFAULT_RULES,
    semantic,
  );
  assert.equal(verdict.kind, 'neutral');
});

test('missing Groq API key safely returns neutral', async () => {
  const logs: string[] = [];
  const provider = createGroqSemanticProvider({} as NodeJS.ProcessEnv);
  const semantic = new CachedSemanticClassifier(provider, (message) => logs.push(message));
  const verdict = await classifyWithSemantic(
    context('Finish Math 185 HW8', 'https://example.com/', 'Generic page'),
    DEFAULT_RULES,
    semantic,
  );

  assert.equal(provider, null);
  assert.equal(verdict.kind, 'neutral');
  assert.ok(logs.includes('[semantic] unconfigured; neutral fallback'));
});

test('Groq model uses a small default and remains configurable', () => {
  const defaultProvider = createGroqSemanticProvider({ GROQ_API_KEY: 'test-key' } as NodeJS.ProcessEnv);
  const configuredProvider = createGroqSemanticProvider({
    GROQ_API_KEY: 'test-key',
    GROQ_MODEL: 'example/smaller-model',
  } as NodeJS.ProcessEnv);

  assert.equal(defaultProvider?.model, DEFAULT_GROQ_MODEL);
  assert.equal(configuredProvider?.model, 'example/smaller-model');
});
