// Prompt and response handling shared by every semantic provider (Groq, Claude, ...).
// Keeping this in one place means providers stay interchangeable: same question, same answer shape.

import type { ActivityContext } from '../shared/types';
import type { SemanticRelevance, SemanticResult } from './semantic';

export const SEMANTIC_SYSTEM_PROMPT =
  'Classify whether the activity directly helps the user complete the intent. Use uncertain when context is insufficient. Keep reason under 20 words.';

/** JSON Schema for the provider answer. Range checks happen in parseSemanticResult. */
export const SEMANTIC_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    relevance: { type: 'string', enum: ['relevant', 'unrelated', 'uncertain'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['relevance', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

export function compact(value: string | null, max = 500): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Host, path and search query only: enough context without sending every URL parameter. */
export function usefulLocation(raw: string | null): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const query = ['q', 'query', 'search', 'keyword', 'keywords']
      .map((key) => url.searchParams.get(key))
      .find(Boolean);
    return compact(`${url.hostname}${decodeURIComponent(url.pathname)}${query ? `; query: ${query}` : ''}`, 700);
  } catch {
    return compact(raw, 700);
  }
}

export function buildSemanticUserPrompt(context: ActivityContext): string {
  const { activity } = context;
  return [
    `Intent: ${compact(context.intent)}`,
    `App: ${compact(activity.app, 100)}`,
    `Title: ${compact(activity.title) || '(none)'}`,
    `Location: ${usefulLocation(activity.url) || '(none)'}`,
  ].join('\n');
}

/** Parse and validate a provider answer. Throws on anything malformed so callers fall back to neutral. */
export function parseSemanticResult(content: string, provider: string, model: string): SemanticResult {
  const value = JSON.parse(content) as Partial<SemanticResult>;
  const relevance = value.relevance as SemanticRelevance;
  if (!['relevant', 'unrelated', 'uncertain'].includes(relevance)) throw new Error('Invalid semantic relevance');
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error('Invalid confidence');
  }
  if (typeof value.reason !== 'string') throw new Error('Invalid reason');
  return {
    relevance,
    confidence: value.confidence,
    reason: value.reason.trim().slice(0, 160),
    provider,
    model,
  };
}
