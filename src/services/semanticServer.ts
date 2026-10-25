// Claude's page check, asked through the call server: the downloaded app ships no API key.
// Only the intent, the app name, the page title and host/path/search query leave the computer, and only for pages
// the app cannot judge on its own (see classifyWithSemantic). Any failure throws, which keeps the page neutral.

import type { ActivityContext } from '../shared/types';
import type { SemanticProvider, SemanticRelevance, SemanticResult } from './semantic';

export interface RelevanceServer {
  relevance(input: { intent: string; app: string; title: string; location: string }): Promise<{
    relevance?: string;
    confidence?: number;
    reason?: string;
  }>;
}

const compact = (value: string | null | undefined, max: number) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Host, path and search query only: enough to judge a page without sending every URL parameter. */
export function usefulLocation(raw: string | null): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const query = ['q', 'query', 'search', 'search_query', 'keyword', 'keywords'].map((key) => url.searchParams.get(key)).find(Boolean);
    return compact(`${url.hostname}${decodeURIComponent(url.pathname)}${query ? `; query: ${query}` : ''}`, 500);
  } catch {
    return compact(raw.split('?')[0], 500);
  }
}

export class ServerSemanticProvider implements SemanticProvider {
  readonly name = 'claude-via-server';
  readonly model = 'server';

  constructor(private readonly server: () => RelevanceServer | null) {}

  async classifySemantic(context: ActivityContext): Promise<SemanticResult> {
    const server = this.server();
    if (!server) throw new Error('No call server connected');
    const { activity } = context;
    const answer = await server.relevance({
      intent: compact(context.intent, 300),
      app: compact(activity.app, 100),
      title: compact(activity.title, 300),
      location: usefulLocation(activity.url),
    });
    const relevance = answer?.relevance as SemanticRelevance;
    const confidence = Number(answer?.confidence);
    if (!['relevant', 'unrelated', 'uncertain'].includes(relevance)) throw new Error('Invalid relevance');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Invalid confidence');
    return { relevance, confidence, reason: compact(answer.reason, 160), provider: this.name, model: this.model };
  }
}
