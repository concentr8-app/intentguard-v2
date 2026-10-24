import type { ActivityContext } from '../shared/types';
import type { SemanticProvider, SemanticRelevance, SemanticResult } from './semantic';

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

type Fetch = typeof fetch;

interface GroqResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
}

function compact(value: string | null, max = 500): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function usefulLocation(raw: string | null): string {
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

function parseResult(content: string, provider: string, model: string): SemanticResult {
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

export class GroqSemanticProvider implements SemanticProvider {
  readonly name = 'groq';

  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_GROQ_MODEL,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  async classifySemantic(context: ActivityContext): Promise<SemanticResult> {
    const { activity } = context;
    const response = await this.fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        reasoning_effort: 'low',
        temperature: 0,
        max_completion_tokens: 160,
        messages: [
          {
            role: 'system',
            content:
              'Classify whether the activity directly helps the user complete the intent. Use uncertain when context is insufficient. Keep reason under 20 words.',
          },
          {
            role: 'user',
            content: [
              `Intent: ${compact(context.intent)}`,
              `App: ${compact(activity.app, 100)}`,
              `Title: ${compact(activity.title) || '(none)'}`,
              `Location: ${usefulLocation(activity.url) || '(none)'}`,
            ].join('\n'),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'activity_relevance',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                relevance: { type: 'string', enum: ['relevant', 'unrelated', 'uncertain'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                reason: { type: 'string' },
              },
              required: ['relevance', 'confidence', 'reason'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`Groq request failed (${response.status})`);
    const data = (await response.json()) as GroqResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Groq response did not include content');
    return parseResult(content, this.name, data.model || this.model);
  }
}

export function createGroqSemanticProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): GroqSemanticProvider | null {
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  return new GroqSemanticProvider(apiKey, env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL, fetchImpl);
}
