// Optional Claude implementation of the semantic relevance check.
// Same contract as the Groq provider: any failure throws, and CachedSemanticClassifier turns that into neutral.

import type { ActivityContext } from '../shared/types';
import type { SemanticProvider, SemanticResult } from './semantic';
import {
  buildSemanticUserPrompt,
  parseSemanticResult,
  SEMANTIC_RESULT_SCHEMA,
  SEMANTIC_SYSTEM_PROMPT,
} from './semanticPrompt';

export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

type Fetch = typeof fetch;

interface ClaudeResponse {
  model?: string;
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
}

export class ClaudeSemanticProvider implements SemanticProvider {
  readonly name = 'claude';

  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_CLAUDE_MODEL,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  async classifySemantic(context: ActivityContext): Promise<SemanticResult> {
    const response = await this.fetchImpl(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 200,
        system: SEMANTIC_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildSemanticUserPrompt(context) }],
        output_config: { format: { type: 'json_schema', schema: SEMANTIC_RESULT_SCHEMA } },
      }),
    });
    if (!response.ok) throw new Error(`Claude request failed (${response.status})`);
    const data = (await response.json()) as ClaudeResponse;
    // A refusal or a truncated answer may not match the schema; treat both as unavailable.
    if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') {
      throw new Error(`Claude response stopped early (${data.stop_reason})`);
    }
    const text = data.content?.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error('Claude response did not include text');
    return parseSemanticResult(text, this.name, data.model || this.model);
  }
}

export function createClaudeSemanticProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): ClaudeSemanticProvider | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return new ClaudeSemanticProvider(apiKey, env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL, fetchImpl);
}
