// "I'm stuck": turns the student's task into one tiny first step.
// Claude suggests it: directly when ANTHROPIC_API_KEY is set (development), otherwise through the call server once
// the student is signed in (the downloaded app ships no key). On any failure a fixed step is used, so the flow
// always completes, offline included.

import type { FirstStep } from '../shared/types';

export const DEFAULT_STEP_MINUTES = 5;
export const DEFAULT_STEP_MODEL = 'claude-haiku-5-5';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

type Fetch = typeof fetch;

export interface StepInput {
  task: string;
  course: string | null;
  taskUrl: string | null;
  attempt: number; // 1 for the first step; higher means the last one was still too big
  previousStep: string | null;
}

export interface StepProvider {
  readonly name: string;
  readonly model: string;
  suggest(input: StepInput): Promise<{ text: string; minutes: number }>;
}

/** Each retry gets smaller. Never depends on a network. */
const FALLBACK_STEPS = [
  'Open the assignment and read only the first paragraph. Nothing else.',
  'Write one sentence: what would "done" look like for this task?',
  'Open a blank page and type the task title at the top. That is all.',
  'Set a 2-minute timer and just look at the task. You do not have to start yet.',
];

export function fallbackStep(input: StepInput): FirstStep {
  const index = Math.min(Math.max(input.attempt, 1), FALLBACK_STEPS.length) - 1;
  return {
    text: FALLBACK_STEPS[index],
    minutes: index === FALLBACK_STEPS.length - 1 ? 2 : DEFAULT_STEP_MINUTES,
    url: input.taskUrl,
    source: 'fallback',
  };
}

const SYSTEM_PROMPT = [
  'You help a university student who feels stuck and cannot start a task.',
  'Reply with exactly one tiny, concrete first action they can do at their computer within the given minutes.',
  'Start with a verb. Under 25 words. No lists, no plans, no pep talk, no medical or therapy language.',
  'Only mention files, pages or details that are clearly implied by the task text; never invent links or file names.',
  'If the task is vague, suggest a step that makes it clearer.',
  'If this is a retry, make the action clearly smaller and easier than the previous one.',
].join(' ');

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    step: { type: 'string' },
    minutes: { type: 'integer' },
  },
  required: ['step', 'minutes'],
  additionalProperties: false,
} as const;

function compact(value: string | null, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildStepPrompt(input: StepInput): string {
  const lines = [`Task: ${compact(input.task, 300)}`];
  if (input.course) lines.push(`Course: ${compact(input.course, 100)}`);
  lines.push(`Minutes available: ${DEFAULT_STEP_MINUTES}`);
  if (input.attempt > 1 && input.previousStep) {
    lines.push(`Retry ${input.attempt}. This step was still too big: "${compact(input.previousStep, 300)}"`);
  }
  return lines.join('\n');
}

/** Validates a provider answer; throws on anything unusable so the caller falls back. */
export function parseStep(content: string): { text: string; minutes: number } {
  const value = JSON.parse(content) as { step?: unknown; minutes?: unknown };
  const text = typeof value.step === 'string' ? value.step.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > 240) throw new Error('Invalid step');
  const raw = typeof value.minutes === 'number' && Number.isFinite(value.minutes) ? Math.round(value.minutes) : DEFAULT_STEP_MINUTES;
  return { text, minutes: Math.min(10, Math.max(2, raw)) };
}

interface ClaudeResponse {
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
}

export class ClaudeStepProvider implements StepProvider {
  readonly name = 'claude';

  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_STEP_MODEL,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  async suggest(input: StepInput): Promise<{ text: string; minutes: number }> {
    const response = await this.fetchImpl(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildStepPrompt(input) }],
        output_config: { format: { type: 'json_schema', schema: STEP_SCHEMA } },
      }),
    });
    if (!response.ok) throw new Error(`Claude request failed (${response.status})`);
    const data = (await response.json()) as ClaudeResponse;
    if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') {
      throw new Error(`Claude response stopped early (${data.stop_reason})`);
    }
    const text = data.content?.find((block) => block.type === 'text')?.text;
    if (!text) throw new Error('Claude response did not include text');
    return parseStep(text);
  }
}

/** The part of the call-server client this needs (kept narrow so tests can fake it). */
export interface StepServer {
  firstStep(input: { task: string; course: string | null; attempt: number; previousStep: string | null }): Promise<{ step: string; minutes: number }>;
}

/** Claude through the call server. Sends only the task, course and previous step, like the direct provider. */
export class ServerStepProvider implements StepProvider {
  readonly name = 'claude-via-server';
  readonly model = 'server';

  constructor(private readonly server: StepServer) {}

  async suggest(input: StepInput): Promise<{ text: string; minutes: number }> {
    const answer = await this.server.firstStep({
      task: input.task,
      course: input.course,
      attempt: input.attempt,
      previousStep: input.previousStep,
    });
    return parseStep(JSON.stringify({ step: answer?.step, minutes: answer?.minutes }));
  }
}

export function createStepProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): StepProvider | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return new ClaudeStepProvider(apiKey, env.ANTHROPIC_MODEL?.trim() || DEFAULT_STEP_MODEL, fetchImpl);
}

/** Claude's step when available, the fixed one otherwise. Never throws. */
export async function suggestFirstStep(
  provider: StepProvider | null,
  input: StepInput,
  log: (message: string) => void = () => {},
): Promise<FirstStep> {
  if (!provider) {
    log('[stuck] no step provider; fixed step');
    return fallbackStep(input);
  }
  try {
    const step = await provider.suggest(input);
    log(`[stuck] step from provider=${provider.name} model=${provider.model}`);
    return { ...step, url: input.taskUrl, source: 'claude' };
  } catch (err) {
    log(`[stuck] provider failure (${(err as Error).message}); fixed step`);
    return fallbackStep(input);
  }
}
