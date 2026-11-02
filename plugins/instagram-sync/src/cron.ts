/**
 * Minimal 5-field cron matcher.
 *
 * Fields: minute hour day-of-month month day-of-week.
 *
 * Supported syntax per field: `*`, a step form (`*` slash `n`), `a-b`, `a,b`,
 * and plain integers.
 * Day-of-week accepts 0-7 with both 0 and 7 meaning Sunday.
 *
 * This is deliberately not a full cron implementation — no seconds field, no
 * `L`/`#`/`W` specials. The server has no cron library and adding one for a
 * single plugin is not worth the dependency.
 */

interface FieldSpec {
  min: number;
  max: number;
  /** Day-of-week wraps: 0 and 7 both mean Sunday. */
  wrap?: boolean;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7, wrap: true }
];

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the day-of-month field was `*` (or equivalent). */
  dayOfMonthWildcard: boolean;
  /** True when the day-of-week field was `*` (or equivalent). */
  dayOfWeekWildcard: boolean;
}

function parseField(raw: string, spec: FieldSpec, label: string): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) {
      throw new Error(`cron ${label} field has an empty entry`);
    }

    const [rangePart, stepPart] = token.split("/");
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`cron ${label} field has an invalid step: ${token}`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number.parseInt(rawStart, 10);
      end = Number.parseInt(rawEnd, 10);
    } else {
      start = Number.parseInt(rangePart, 10);
      end = stepPart === undefined ? start : spec.max;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`cron ${label} field has an invalid value: ${token}`);
    }
    if (start < spec.min || end > spec.max || start > end) {
      throw new Error(`cron ${label} field is out of range: ${token}`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(spec.wrap && value === 7 ? 0 : value);
    }
  }

  if (values.size === 0) {
    throw new Error(`cron ${label} field matches nothing`);
  }
  return values;
}

/** Parse a 5-field cron expression. Throws on malformed input. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}`);
  }

  return {
    minutes: parseField(fields[0], FIELD_SPECS[0], "minute"),
    hours: parseField(fields[1], FIELD_SPECS[1], "hour"),
    daysOfMonth: parseField(fields[2], FIELD_SPECS[2], "day-of-month"),
    months: parseField(fields[3], FIELD_SPECS[3], "month"),
    daysOfWeek: parseField(fields[4], FIELD_SPECS[4], "day-of-week"),
    dayOfMonthWildcard: fields[2].trim() === "*",
    dayOfWeekWildcard: fields[4].trim() === "*"
  };
}

/** Does the given local time satisfy the already-parsed expression? */
function matchesParsedCron(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minutes.has(date.getMinutes())) return false;
  if (!parsed.hours.has(date.getHours())) return false;
  if (!parsed.months.has(date.getMonth() + 1)) return false;

  // Standard cron semantics: when both day fields are restricted, the match
  // is a union of the two; otherwise the restricted one applies alone.
  const dayOfMonth = parsed.daysOfMonth.has(date.getDate());
  const dayOfWeek = parsed.daysOfWeek.has(date.getDay());

  if (parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard) return true;
  if (parsed.dayOfMonthWildcard) return dayOfWeek;
  if (parsed.dayOfWeekWildcard) return dayOfMonth;
  return dayOfMonth || dayOfWeek;
}

/** Does the given local time satisfy the cron expression? */
export function matchesCron(expression: string, date: Date): boolean {
  return matchesParsedCron(parseCron(expression), date);
}

/**
 * Next time the expression matches, scanning minute by minute.
 * Returns null when nothing matches within a year (e.g. `0 0 30 2 *`).
 */
export function nextRun(expression: string, from: Date): Date | null {
  const parsed = parseCron(expression);

  // Start at the next whole minute after `from`.
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = 366 * 24 * 60;
  for (let step = 0; step < limit; step += 1) {
    if (matchesParsedCron(parsed, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
