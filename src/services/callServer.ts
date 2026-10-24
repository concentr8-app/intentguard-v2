// Client for the Concentr8 Call Server (runs on Replit, phones the student via Twilio).
// The contract lives in docs/call-server-api.md — keep both sides in sync.

import type { Task } from '../shared/types';

export interface ServerToday {
  date: string;
  focusTask: string | null;
  startTime: string | null;
  lastCallAt: string | null;
  lastCallStatus: string | null;
}

export class CallServerError extends Error {}

export class CallServerClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly apiKey: string) {
    this.base = baseUrl.trim().replace(/\/+$/, '');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<T> {
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
    if (!res.ok) throw new CallServerError(`Call server answered ${res.status}`);
    return (await res.json()) as T;
  }

  health(): Promise<{ ok: boolean }> {
    return this.request('GET', '/api/health', undefined, false);
  }

  pushTasks(tasks: Task[]): Promise<{ ok: boolean; count: number }> {
    const slim = tasks.map(({ id, title, course, dueAt, url }) => ({ id, title, course, dueAt, url }));
    return this.request('POST', '/api/tasks', { tasks: slim });
  }

  today(): Promise<ServerToday> {
    return this.request('GET', '/api/today');
  }

  callNow(): Promise<{ ok: boolean; callSid: string }> {
    return this.request('POST', '/api/call-now', {});
  }

  saveSettings(settings: { phoneNumber?: string; callTime?: string; timezone?: string }): Promise<{ ok: boolean }> {
    return this.request('POST', '/api/settings', settings);
  }
}
