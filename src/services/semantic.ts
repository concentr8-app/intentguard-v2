import type { ActivityContext, Rules, Verdict } from '../shared/types';
import { classify as classifyDeterministic } from './rules';

export type SemanticRelevance = 'relevant' | 'unrelated' | 'uncertain';

export interface SemanticResult {
  relevance: SemanticRelevance;
  confidence: number;
  reason: string;
  provider?: string;
  model?: string;
}

export interface SemanticProvider {
  readonly name: string;
  readonly model: string;
  classifySemantic(context: ActivityContext): Promise<SemanticResult>;
}

export type RelevanceLog = (message: string) => void;

export const SEMANTIC_CONFIDENCE_THRESHOLD = 0.85;

const uncertain = (reason: string): SemanticResult => ({ relevance: 'uncertain', confidence: 0, reason });

function cacheKey(context: ActivityContext): string {
  const { activity, intent } = context;
  return JSON.stringify([
    intent.trim().toLowerCase(),
    activity.app.trim().toLowerCase(),
    activity.title?.trim() ?? '',
    activity.url?.trim() ?? '',
  ]);
}

/** Session-local semantic classification with in-flight request de-duplication. */
export class CachedSemanticClassifier {
  private readonly cache = new Map<string, Promise<SemanticResult>>();

  constructor(
    private readonly provider: SemanticProvider | null,
    private readonly log: RelevanceLog = () => {},
  ) {}

  clear(): void {
    this.cache.clear();
  }

  async classifySemantic(context: ActivityContext): Promise<SemanticResult> {
    const key = cacheKey(context);
    const cached = this.cache.get(key);
    if (cached) {
      this.log('[semantic] cache hit');
      return cached;
    }

    let request: Promise<SemanticResult>;
    if (!this.provider) {
      this.log('[semantic] unconfigured; neutral fallback');
      request = Promise.resolve(uncertain('Semantic provider is not configured.'));
    } else {
      this.log(`[semantic] API call provider=${this.provider.name} model=${this.provider.model}`);
      request = this.provider.classifySemantic(context).catch(() => {
        this.log('[semantic] provider failure; neutral fallback');
        return uncertain('Semantic provider was unavailable.');
      });
    }
    this.cache.set(key, request);
    return request;
  }
}

export async function classifyWithSemantic(
  context: ActivityContext,
  rules: Rules,
  semantic?: CachedSemanticClassifier,
  log: RelevanceLog = () => {},
): Promise<Verdict> {
  const deterministic = classifyDeterministic(context, rules);
  if (deterministic.kind !== 'neutral') {
    log(`[relevance] deterministic ${deterministic.kind}`);
    return deterministic;
  }

  log('[relevance] deterministic neutral');
  if (!semantic) return deterministic;

  const result = await semantic.classifySemantic(context);
  if (
    !Number.isFinite(result.confidence) ||
    result.confidence < SEMANTIC_CONFIDENCE_THRESHOLD ||
    result.confidence > 1
  ) {
    return deterministic;
  }
  if (result.relevance === 'relevant') return { kind: 'focus' };
  if (result.relevance === 'unrelated') {
    const reason = result.reason.trim().slice(0, 160) || 'Activity is unrelated to the current intent.';
    return { kind: 'distraction', reason };
  }
  return deterministic;
}
