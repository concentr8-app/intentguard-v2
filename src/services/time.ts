// Time helpers that respect the student's timezone without any date library,
// plus a small parser for spoken start times ("nine thirty a.m.", "in 10 minutes").

/** Wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** "2026-10-24" for `date` in `timeZone`. */
export function localDate(date: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "08:00" for `date` in `timeZone`. */
export function localHHMM(date: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(date, timeZone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Milliseconds that `timeZone` is ahead of UTC at `date`. */
function offsetMs(date: Date, timeZone: string): number {
  const z = zonedParts(date, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant when the wall clock in `timeZone` shows `dayOffset` days after `now`, at hour:minute. */
export function atLocalTime(now: Date, timeZone: string, hour: number, minute: number, dayOffset = 0): Date {
  const z = zonedParts(now, timeZone);
  const guess = Date.UTC(z.year, z.month - 1, z.day + dayOffset, hour, minute, 0);
  return new Date(guess - offsetMs(new Date(guess), timeZone));
}

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

/** "nine forty five" -> "9 45", "nine oh five" -> "9 05" */
function wordsToDigits(text: string): string {
  const tokens = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t in TENS) {
      const next = tokens[i + 1];
      if (next && next in SMALL && SMALL[next] > 0 && SMALL[next] < 10) {
        out.push(String(TENS[t] + SMALL[next]));
        i++;
      } else out.push(String(TENS[t]));
    } else if (t === 'oh' && tokens[i + 1] && tokens[i + 1] in SMALL) {
      out.push('0' + SMALL[tokens[i + 1]]);
      i++;
    } else if (t in SMALL && t !== 'oh') {
      out.push(String(SMALL[t]));
    } else out.push(t);
  }
  return out.join(' ');
}

/**
 * Turn what the student said into an instant, or null if we can't tell.
 * Without am/pm we pick the next upcoming occurrence (said at 8am, "two" means 2pm).
 */
export function parseSpokenTime(spoken: string, now: Date, timeZone: string): Date | null {
  let s = ` ${spoken.toLowerCase()} `
    .replace(/a\.\s?m\.?/g, 'am')
    .replace(/p\.\s?m\.?/g, 'pm')
    .replace(/o'clock/g, '')
    .replace(/[,!?]/g, ' ')
    .replace(/\s+/g, ' ');
  s = ` ${wordsToDigits(s.trim())} `;

  if (/\b(now|right away|immediately|asap|straight away)\b/.test(s)) return new Date(now);

  const rel = s.match(/\bin (\d+|a|an|half an?) ?(minutes?|mins?|hours?|hrs?)\b/);
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : rel[1].startsWith('half') ? 0.5 : Number(rel[1]);
    const ms = rel[2].startsWith('h') ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() + ms);
  }
  if (/\bin half an hour\b/.test(s)) return new Date(now.getTime() + 1_800_000);

  let hour: number | null = null;
  let minute = 0;
  let meridiem: 'am' | 'pm' | null = null;

  if (/\bnoon\b/.test(s)) {
    hour = 12;
    meridiem = 'pm';
  }

  const past = s.match(/\b(quarter|half) past (\d{1,2})\b/);
  const to = s.match(/\bquarter to (\d{1,2})\b/);
  if (hour === null && past) {
    hour = Number(past[2]);
    minute = past[1] === 'quarter' ? 15 : 30;
  } else if (hour === null && to) {
    hour = Number(to[1]) - 1;
    minute = 45;
  }

  if (hour === null) {
    const m = s.match(/\b(\d{1,2})(?:[:.](\d{2})|\s(\d{2}))?\s?(am|pm)?\b/);
    if (m) {
      hour = Number(m[1]);
      minute = Number(m[2] ?? m[3] ?? 0);
      meridiem = (m[4] as 'am' | 'pm' | undefined) ?? null;
    }
  }
  const mer = s.match(/\b(am|pm)\b/);
  if (mer && !meridiem) meridiem = mer[1] as 'am' | 'pm';
  if (/\b(morning)\b/.test(s) && !meridiem) meridiem = 'am';
  if (/\b(afternoon|evening|tonight)\b/.test(s) && !meridiem) meridiem = 'pm';

  if (hour === null || hour > 23 || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const candidates: Date[] = [];
  if (meridiem || hour > 12 || hour === 0) {
    candidates.push(atLocalTime(now, timeZone, hour, minute));
  } else {
    candidates.push(atLocalTime(now, timeZone, hour, minute));
    if (hour < 12) candidates.push(atLocalTime(now, timeZone, hour + 12, minute));
  }
  const graceMs = 15 * 60_000; // "nine" said at 9:05 still means today 9:00
  const upcoming = candidates.find((c) => c.getTime() >= now.getTime() - graceMs);
  if (upcoming) return upcoming;
  return atLocalTime(now, timeZone, hour, minute, 1); // already passed today -> tomorrow
}
