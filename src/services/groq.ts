import type { ActivityContext } from '../shared/types';
import type { SemanticProvider, SemanticResult } from './semantic';
import {
  buildSemanticUserPrompt,
  parseSemanticResult,
  SEMANTIC_RESULT_SCHEMA,
  SEMANTIC_SYSTEM_PROMPT,
} from './semanticPrompt';

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

type Fetch = typeof fetch;

interface GroqResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
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
          { role: 'system', content: SEMANTIC_SYSTEM_PROMPT },
          { role: 'user', content: buildSemanticUserPrompt(context) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'activity_relevance',
            strict: true,
            schema: SEMANTIC_RESULT_SCHEMA,
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`Groq request failed (${response.status})`);
    const data = (await response.json()) as GroqResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Groq response did not include content');
    return parseSemanticResult(content, this.name, data.model || this.model);
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
