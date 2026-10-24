import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeSemanticProvider, createClaudeSemanticProvider, DEFAULT_CLAUDE_MODEL } from '../services/claude';
import { createSemanticProvider } from '../services/providers';
import { DEFAULT_RULES } from '../services/rules';
import { CachedSemanticClassifier, classifyWithSemantic } from '../services/semantic';
import type { ActivityContext } from '../shared/types';

const context = (intent: string, url: string | null, title: string | null): ActivityContext => ({
  activity: { app: 'Google Chrome', url, title, at: 0 },
  intent,
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** Fake fetch that records the request and answers like the Messages API. */
function fakeFetch(reply: { status?: number; body?: unknown }) {
  const requests: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const answer = (json: object, extra: object = {}) => ({
  body: { model: DEFAULT_CLAUDE_MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }], ...extra },
});

const neutralPage = context('Finish Math 185 HW8', 'https://www.google.com/search?q=nfl+scores&token=secret123', 'nfl scores');

test('Claude request uses the Messages API with structured output and no key in the body', async () => {
  const fetch = fakeFetch(answer({ relevance: 'unrelated', confidence: 0.95, reason: 'Sports scores' }));
  await new ClaudeSemanticProvider('test-key', DEFAULT_CLAUDE_MODEL, fetch.impl).classifySemantic(neutralPage);

  const [request] = fetch.requests;
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'test-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.body.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(request.body.output_config.format.type, 'json_schema');
  assert.ok(!JSON.stringify(request.body).includes('test-key'));
});

test('Claude only receives intent, app, title and the search query, not other URL parameters', async () => {
  const fetch = fakeFetch(answer({ relevance: 'unrelated', confidence: 0.95, reason: 'Sports scores' }));
  await new ClaudeSemanticProvider('test-key', DEFAULT_CLAUDE_MODEL, fetch.impl).classifySemantic(neutralPage);

  const prompt = fetch.requests[0].body.messages[0].content as string;
  assert.ok(prompt.includes('Intent: Finish Math 185 HW8'));
  assert.ok(prompt.includes('query: nfl scores'));
  assert.ok(!prompt.includes('secret123'));
});

test('a confident Claude verdict becomes a distraction with its reason', async () => {
  const fetch = fakeFetch(answer({ relevance: 'unrelated', confidence: 0.93, reason: 'NFL scores do not help with complex analysis homework' }));
  const semantic = new CachedSemanticClassifier(new ClaudeSemanticProvider('k', DEFAULT_CLAUDE_MODEL, fetch.impl));

  const verdict = await classifyWithSemantic(neutralPage, DEFAULT_RULES, semantic);
  assert.equal(verdict.kind, 'distraction');
  assert.match((verdict as { reason: string }).reason, /NFL scores/);
});

test('Claude errors, refusals, truncation and malformed answers all stay neutral', async () => {
  const replies = [
    { status: 529, body: {} },
    answer({ relevance: 'unrelated', confidence: 0.99, reason: 'x' }, { stop_reason: 'refusal' }),
    answer({ relevance: 'unrelated', confidence: 0.99, reason: 'x' }, { stop_reason: 'max_tokens' }),
    { body: { content: [{ type: 'text', text: 'not json' }] } },
    answer({ relevance: 'unrelated', confidence: 7, reason: 'x' }),
    { body: { content: [] } },
  ];
  for (const reply of replies) {
    const semantic = new CachedSemanticClassifier(
      new ClaudeSemanticProvider('k', DEFAULT_CLAUDE_MODEL, fakeFetch(reply).impl),
    );
    assert.equal((await classifyWithSemantic(neutralPage, DEFAULT_RULES, semantic)).kind, 'neutral');
  }
});

test('Claude provider needs a key and keeps the model configurable', () => {
  assert.equal(createClaudeSemanticProvider({} as NodeJS.ProcessEnv), null);
  assert.equal(createClaudeSemanticProvider({ ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)?.model, DEFAULT_CLAUDE_MODEL);
  assert.equal(
    createClaudeSemanticProvider({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-sonnet-5-5' } as NodeJS.ProcessEnv)?.model,
    'claude-sonnet-5-5',
  );
});

test('provider selection prefers Claude, falls back to Groq, and honours SEMANTIC_PROVIDER', () => {
  const both = { ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'g' } as NodeJS.ProcessEnv;
  assert.equal(createSemanticProvider(both)?.name, 'claude');
  assert.equal(createSemanticProvider({ GROQ_API_KEY: 'g' } as NodeJS.ProcessEnv)?.name, 'groq');
  assert.equal(createSemanticProvider({ ...both, SEMANTIC_PROVIDER: 'groq' })?.name, 'groq');
  assert.equal(createSemanticProvider({ ...both, SEMANTIC_PROVIDER: 'none' }), null);
  assert.equal(createSemanticProvider({ GROQ_API_KEY: 'g', SEMANTIC_PROVIDER: 'claude' } as NodeJS.ProcessEnv), null);
  assert.equal(createSemanticProvider({} as NodeJS.ProcessEnv), null);
});
