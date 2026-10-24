// Links what the student said on the phone ("the CS 188 project") to a Canvas task,
// so "back to work" can open the right assignment.

import type { Task } from '../shared/types';

const STOP = new Set([
  'the', 'a', 'an', 'my', 'i', 'will', 'start', 'with', 'on', 'for', 'to', 'do', 'work', 'working',
  'first', 'and', 'of', 'it', 'that', 'this', 'gonna', 'going', 'want', 'think', 'probably', 'just',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2') // "cs188" -> "cs 188"
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

/** Best matching task, or null if nothing overlaps meaningfully. */
export function matchTask(spoken: string, tasks: Task[]): Task | null {
  const said = new Set(tokens(spoken));
  if (said.size === 0) return null;
  let best: Task | null = null;
  let bestScore = 0;
  for (const task of tasks) {
    const words = new Set([...tokens(task.title), ...tokens(task.course)]);
    let score = 0;
    for (const w of said) {
      if (words.has(w)) score += /^\d+$/.test(w) ? 2 : 1; // course numbers are strong signals
    }
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return bestScore >= 1 ? best : null;
}
