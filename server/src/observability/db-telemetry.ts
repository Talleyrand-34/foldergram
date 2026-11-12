/**
 * Telemetry of the database access.
 *
 * The drivers measure the time of every query next to the query itself, and
 * the measurement is reported twice:
 *
 *  - as a histogram, so the percentiles can be read in Prometheus or Grafana
 *    ("how long does the database take?"),
 *  - as a span, so one query can be seen in the trace, next to the request
 *    that caused it.
 *
 * The statement itself never becomes a label: one time series per statement
 * would blow up the backend. What becomes a label is the operation and the
 * table, both bounded by the schema.
 */

import { SpanStatusCode, trace, type Attributes, type Counter, type Histogram } from '@opentelemetry/api';

import { getInstruments } from './instruments.js';

const TRACER_NAME = 'foldergram.db';

/** The drivers that can be measured. */
export type DbDialect = 'sqlite' | 'postgres';

export interface DbQuerySample {
  /** The driver that ran the query. */
  readonly dialect: DbDialect;
  /** The statement, as the repository wrote it. */
  readonly sql: string;
  /** How long the query took, in milliseconds. */
  readonly elapsedMs: number;
  /** The error that made the query fail, if it failed. */
  readonly error?: unknown;
}

/**
 * The verbs that become an `operation` label.
 *
 * Anything else is reported as `OTHER`, so a statement nobody thought about
 * cannot create an unbounded number of series.
 */
const KNOWN_OPERATIONS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'WITH',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'CREATE',
  'ALTER',
  'DROP'
]);

/** The first table the statement touches, with its schema if it has one. */
const TABLE_PATTERN = /\b(?:from|into|update|join)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/i;

export interface QueryDescription {
  /** The verb of the statement, in upper case. */
  readonly operation: string;
  /** The first table the statement touches, in lower case. */
  readonly table: string;
}

/**
 * Describes a statement with the two labels that are safe to keep.
 *
 * @param sql The statement, with its placeholders.
 */
export function describeQuery(sql: string): QueryDescription {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const verb = normalized.split(' ')[0]?.toUpperCase() ?? '';
  const operation = KNOWN_OPERATIONS.has(verb) ? verb : 'OTHER';

  const match = TABLE_PATTERN.exec(normalized);
  const rawTable = match?.[1]?.toLowerCase() ?? '';
  // A qualified name (`public.media`) is reported without the schema.
  const table = rawTable.includes('.') ? (rawTable.split('.').pop() ?? rawTable) : rawTable;

  return { operation, table: table || 'unknown' };
}

interface DbInstruments {
  readonly duration: Histogram;
  readonly count: Counter;
}

function getDbInstruments(): DbInstruments {
  return getInstruments('db', (meter) => ({
    duration: meter.createHistogram('foldergram.db.query.duration', {
      description: 'How long a database query took, in milliseconds',
      unit: 'ms'
    }),
    count: meter.createCounter('foldergram.db.query.count', {
      description: 'Database queries performed, by dialect, operation and outcome'
    })
  }));
}

function describeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }

  return { message: String(error), name: 'Error' };
}

/**
 * Records one database query.
 *
 * It never throws: a broken measurement must not break the query that was
 * being measured.
 */
export function recordDbQuery(sample: DbQuerySample): void {
  try {
    const { operation, table } = describeQuery(sample.sql);
    const status = sample.error ? 'error' : 'ok';

    const labels: Attributes = {
      dialect: sample.dialect,
      operation,
      table,
      status
    };

    const { duration, count } = getDbInstruments();
    count.add(1, labels);
    duration.record(sample.elapsedMs, labels);

    recordDbQuerySpan(sample, operation, table, status);
  } catch {
    // The measurement is best effort.
  }
}

function recordDbQuerySpan(
  sample: DbQuerySample,
  operation: string,
  table: string,
  status: string
): void {
  const tracer = trace.getTracer(TRACER_NAME);
  const endedAt = Date.now();

  // The query was measured somewhere else, so the span is given a start time
  // in the past: that is the only way to turn a measured duration into a span
  // that sits where it belongs in the trace.
  const span = tracer.startSpan('db.query', {
    startTime: endedAt - sample.elapsedMs,
    attributes: {
      'db.system': sample.dialect === 'postgres' ? 'postgresql' : 'sqlite',
      'db.operation': operation,
      'db.sql.table': table,
      'db.duration_ms': sample.elapsedMs,
      'db.status': status
    }
  });

  if (sample.error) {
    const described = describeError(sample.error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: described.message });
    span.setAttribute('db.error', described.message);
  }

  span.end(endedAt);
}
