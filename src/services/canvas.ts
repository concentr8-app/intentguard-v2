// Canvas LMS client (Berkeley calls it bCourses).
// Uses a personal access token: bCourses -> Account -> Settings -> "+ New Access Token".
// Docs: https://canvas.instructure.com/doc/api/

import type { Task } from '../shared/types';

export const BERKELEY_CANVAS = 'https://bcourses.berkeley.edu';

export class CanvasError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface CanvasCourse {
  id: number;
  name: string;
  course_code?: string;
}

interface PlannerItem {
  plannable_id: number | string;
  plannable_type: string; // assignment | quiz | discussion_topic | planner_note | calendar_event | announcement | wiki_page
  plannable_date?: string;
  course_id?: number;
  context_name?: string;
  html_url?: string;
  plannable?: { title?: string; due_at?: string | null; todo_date?: string | null };
  submissions?: false | { submitted?: boolean; excused?: boolean; graded?: boolean };
  planner_override?: { marked_complete?: boolean } | null;
}

/** Pulls `rel="next"` out of Canvas' Link header for pagination. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export class CanvasClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly token: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async get<T>(pathOrUrl: string): Promise<{ data: T; next: string | null }> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.base}${pathOrUrl}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new CanvasError(`Can't reach Canvas (${(err as Error).message})`);
    }
    if (res.status === 401) throw new CanvasError('Canvas rejected the token. Create a new one in bCourses → Account → Settings.', 401);
    if (!res.ok) throw new CanvasError(`Canvas answered ${res.status}`, res.status);
    return { data: (await res.json()) as T, next: nextLink(res.headers.get('link')) };
  }

  private async getAll<T>(path: string, maxPages = 10): Promise<T[]> {
    const all: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const page: { data: T[]; next: string | null } = await this.get<T[]>(next);
      all.push(...page.data);
      next = page.next;
    }
    return all;
  }

  /** Checks the token and returns the student's display name. */
  async whoAmI(): Promise<string> {
    const { data } = await this.get<{ name?: string; short_name?: string }>('/api/v1/users/self');
    return data.short_name || data.name || 'Student';
  }

  async courses(): Promise<CanvasCourse[]> {
    return this.getAll<CanvasCourse>('/api/v1/courses?enrollment_state=active&per_page=100');
  }

  /** Everything due in the next `days` days that isn't submitted yet, earliest first. */
  async upcomingTasks(days = 14, now = new Date()): Promise<Task[]> {
    const start = new Date(now.getTime() - 24 * 3_600_000); // include things due earlier today
    const end = new Date(now.getTime() + days * 24 * 3_600_000);
    const [items, courses] = await Promise.all([
      this.getAll<PlannerItem>(
        `/api/v1/planner/items?start_date=${encodeURIComponent(start.toISOString())}` +
          `&end_date=${encodeURIComponent(end.toISOString())}&per_page=100`,
      ),
      this.courses().catch(() => [] as CanvasCourse[]),
    ]);
    const courseNames = new Map(courses.map((c) => [c.id, c.course_code || c.name]));
    return normalizePlannerItems(items, courseNames, this.base, now);
  }
}

export function normalizePlannerItems(
  items: PlannerItem[],
  courseNames: Map<number, string>,
  base: string,
  now = new Date(),
): Task[] {
  const kinds: Record<string, Task['kind']> = {
    assignment: 'assignment',
    quiz: 'quiz',
    discussion_topic: 'discussion',
    planner_note: 'note',
  };
  const tasks: Task[] = [];
  for (const item of items) {
    const kind = kinds[item.plannable_type];
    if (!kind) continue; // skip announcements, calendar events, pages
    const sub = item.submissions;
    if (sub && (sub.submitted || sub.excused)) continue;
    if (item.planner_override?.marked_complete) continue; // checked off in the Canvas planner
    const dueAt = item.plannable?.due_at || item.plannable?.todo_date || item.plannable_date || null;
    if (dueAt && new Date(dueAt).getTime() < now.getTime() - 24 * 3_600_000) continue;
    const course =
      (item.course_id !== undefined && courseNames.get(item.course_id)) || item.context_name || 'Personal';
    const url = item.html_url ? (item.html_url.startsWith('http') ? item.html_url : base + item.html_url) : null;
    tasks.push({
      id: `${item.plannable_type}-${item.plannable_id}`,
      title: item.plannable?.title || 'Untitled',
      course,
      dueAt,
      url,
      kind,
    });
  }
  return sortByDue(tasks);
}

export function sortByDue(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
}

/** Realistic fake data so the app can be demoed without a bCourses token. */
export function demoTasks(now = new Date()): Task[] {
  const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  return [
    { id: 'demo-1', title: 'Project 2: Multi-Agent Search', course: 'COMPSCI 188', dueAt: at(20), url: 'https://bcourses.berkeley.edu/', kind: 'assignment' },
    { id: 'demo-2', title: 'Problem Set 6 — Markov Chains', course: 'STAT 134', dueAt: at(31), url: 'https://bcourses.berkeley.edu/', kind: 'assignment' },
    { id: 'demo-3', title: 'Reading Response: Week 9', course: 'ENGIN 183E', dueAt: at(44), url: 'https://bcourses.berkeley.edu/', kind: 'discussion' },
    { id: 'demo-4', title: 'Midterm 2 Practice Quiz', course: 'DATA 100', dueAt: at(70), url: 'https://bcourses.berkeley.edu/', kind: 'quiz' },
    { id: 'demo-5', title: 'Lab 7: Linear Programming', course: 'IND ENG 160', dueAt: at(96), url: 'https://bcourses.berkeley.edu/', kind: 'assignment' },
  ];
}
