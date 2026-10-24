// Picks the optional semantic provider from the environment. The focus engine never sees which one it got.

import { createClaudeSemanticProvider } from './claude';
import { createGroqSemanticProvider } from './groq';
import type { SemanticProvider } from './semantic';

type Fetch = typeof fetch;

/**
 * SEMANTIC_PROVIDER=claude | groq | none chooses explicitly.
 * Unset: Claude when ANTHROPIC_API_KEY is present, otherwise Groq when GROQ_API_KEY is present, otherwise none.
 * A missing key for the chosen provider means no provider, so relevance stays deterministic.
 */
export function createSemanticProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): SemanticProvider | null {
  const choice = env.SEMANTIC_PROVIDER?.trim().toLowerCase();
  if (choice === 'none' || choice === 'off') return null;
  if (choice === 'claude') return createClaudeSemanticProvider(env, fetchImpl);
  if (choice === 'groq') return createGroqSemanticProvider(env, fetchImpl);
  return createClaudeSemanticProvider(env, fetchImpl) ?? createGroqSemanticProvider(env, fetchImpl);
}
