// Client for the Concentr8 Call Server (runs on Replit, phones the student via Twilio).
// The contract lives in docs/call-server-api.md — keep both sides in sync.

import type { Task } from '../shared/types';

export interface ServerToday {
  date: string;
  focusTask: string | null;
  startTime: string | null;
  lastCallAt: string | null;
  lastCallStatus: string | null;
  /** Proposed for the stuck call (docs/call-server-api.md): the first step agreed on the phone. */
  firstStep?: string | null;
  firstStepAt?: string | null;
}

export interface ServerHealth {
  ok: boolean;
  /** Proposed: optional capabilities, e.g. "stuck-call". Older servers send none. */
  features?: string[];
}

/** Proposed body for /api/call-now. Older servers ignore it and place the morning call. */
export interface CallRequest {
  reason?: 'stuck';
  task?: string;
}

export class CallServerError extends Error {}

/** The shared call server of this app. Students only need an invite code to use it. */
export const DEFAULT_SERVER_URL = 'https://concentr8-calls-dqakcah0a0f7edhn.swedencentral-01.azurewebsites.net';

async function errorMessage(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

export class CallServerClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly apiKey: string) {
    this.base = baseUrl.trim().replace(/\/+$/, '');
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new CallServerError(`Call server unreachable (${(err as Error).message})`);
    }
    if (res.status === 401 || res.status === 403) throw new CallServerError('Call server rejected the API key');
    if (!res.ok) throw new CallServerError((await errorMessage(res)) || `Call server answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** Signs a new student up and returns their personal token (stored in the keychain by the caller). */
  static async register(
    baseUrl: string,
    input: { phoneNumber: string; inviteCode: string; callTime: string; timezone: string },
  ): Promise<{ userId: string; token: string }> {
    let res: Response;
    try {
      res = await fetch(baseUrl.trim().replace(/\/+$/, '') + '/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...input, consent: true }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new CallServerError(`Call server unreachable (${(err as Error).message})`);
    }
    if (!res.ok) throw new CallServerError((await errorMessage(res)) || `Call server answered ${res.status}`);
    const body = (await res.json()) as { userId: string; token: string };
    return { userId: body.userId, token: body.token };
  }

  /** Stops the morning calls and deletes this student's data on the server. */
  deleteAccount(): Promise<{ ok: boolean }> {
    return this.request('DELETE', '/api/me');
  }

  health(): Promise<ServerHealth> {
    return this.request('GET', '/api/health', undefined, false);
  }

  /** True only when the server says it can run a stuck call; anything else (old server, offline) is false. */
  async supportsStuckCall(): Promise<boolean> {
    try {
      const health = await this.health();
      return Array.isArray(health.features) && health.features.includes('stuck-call');
    } catch {
      return false;
    }
  }

  pushTasks(tasks: Task[]): Promise<{ ok: boolean; count: number }> {
    const slim = tasks.map(({ id, title, course, dueAt, url }) => ({ id, title, course, dueAt, url }));
    return this.request('POST', '/api/tasks', { tasks: slim });
  }

  today(): Promise<ServerToday> {
    return this.request('GET', '/api/today');
  }

  /** Claude's first step for "I'm stuck", asked through the server (the app ships no API key). */
  firstStep(input: { task: string; course: string | null; attempt: number; previousStep: string | null }): Promise<{ step: string; minutes: number }> {
    return this.request('POST', '/api/first-step', {
      task: input.task,
      course: input.course,
      attempt: input.attempt,
      previous_step: input.previousStep,
    });
  }

  /** Claude's check of a page the app cannot judge itself, asked through the server. */
  relevance(input: {
    intent: string;
    app: string;
    title: string;
    location: string;
    task: { title: string; course: string; kind: string; dueAt: string | null; description: string | null } | null;
  }): Promise<{ relevance: string; confidence: number; reason: string }> {
    return this.request('POST', '/api/relevance', input);
  }

  callNow(request: CallRequest = {}): Promise<{ ok: boolean; callSid: string }> {
    return this.request('POST', '/api/call-now', request);
  }

  saveSettings(settings: { phoneNumber?: string; callTime?: string; timezone?: string }): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/settings', settings);
  }
}
