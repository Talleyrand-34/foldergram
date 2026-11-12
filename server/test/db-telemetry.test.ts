import { metrics, trace } from '@opentelemetry/api';
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeQuery, recordDbQuery } from '../src/observability/db-telemetry.js';

interface MetricPoint {
  readonly attributes: Record<string, unknown>;
  readonly value: number;
}

function readValue(raw: unknown): number {
  if (typeof raw === 'number') {
    return raw;
  }

  // A histogram reports an object: the sum of the recorded values, the count
  // and the buckets.
  if (raw && typeof raw === 'object' && 'sum' in raw) {
    const sum = (raw as { sum?: number }).sum;
    return typeof sum === 'number' ? sum : 0;
  }

  return 0;
}

function collect(exporter: InMemoryMetricExporter): Map<string, MetricPoint[]> {
  const collected = new Map<string, MetricPoint[]>();

  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const points = metric.dataPoints.map((point) => ({
          attributes: (point as { attributes?: Record<string, unknown> }).attributes ?? {},
          value: readValue((point as { value?: unknown }).value)
        }));

        collected.set(metric.descriptor.name, points);
      }
    }
  }

  return collected;
}

describe('db telemetry', () => {
  let exporter: InMemoryMetricExporter;
  let provider: MeterProvider;
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: TracerProvider;

  beforeEach(() => {
    // The global provider can only be set once per process, so it is reset
    // between the tests.
    metrics.disable();
    trace.disable();

    exporter = new InMemoryMetricExporter();
    provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 })]
    });

    metrics.setGlobalMeterProvider(provider);

    spanExporter = new InMemorySpanExporter();
    tracerProvider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })]
    });

    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    await tracerProvider.shutdown();
    trace.disable();
  });

  it('describes a statement with the operation and the table', () => {
    expect(describeQuery('SELECT id FROM media WHERE id = ?')).toEqual({
      operation: 'SELECT',
      table: 'media'
    });

    expect(describeQuery('INSERT INTO folders (name) VALUES (?)')).toEqual({
      operation: 'INSERT',
      table: 'folders'
    });

    expect(describeQuery('UPDATE media SET title = ? WHERE id = ?')).toEqual({
      operation: 'UPDATE',
      table: 'media'
    });

    // A qualified name is reported without the schema.
    expect(describeQuery('SELECT id FROM public.media')).toEqual({
      operation: 'SELECT',
      table: 'media'
    });

    // A verb nobody thought about does not become a new label.
    expect(describeQuery('EXPLAIN SELECT 1')).toEqual({
      operation: 'OTHER',
      table: 'unknown'
    });
  });

  it('records the duration of a query with its labels', async () => {
    recordDbQuery({
      dialect: 'postgres',
      sql: 'SELECT id FROM media WHERE id = ?',
      elapsedMs: 42
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const duration = collected.get('foldergram.db.query.duration');
    expect(duration).toHaveLength(1);
    expect(duration?.[0]?.value).toBe(42);
    expect(duration?.[0]?.attributes).toMatchObject({
      dialect: 'postgres',
      operation: 'SELECT',
      table: 'media',
      status: 'ok'
    });

    const count = collected.get('foldergram.db.query.count');
    expect(count?.[0]?.value).toBe(1);
  });

  it('keeps the statement out of the labels', async () => {
    recordDbQuery({
      dialect: 'postgres',
      sql: 'SELECT id FROM media WHERE path = ?',
      elapsedMs: 3
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const labels = Object.keys(collected.get('foldergram.db.query.duration')?.[0]?.attributes ?? {});
    expect(labels.sort()).toEqual(['dialect', 'operation', 'status', 'table']);
  });

  it('records a failed query as an error', async () => {
    recordDbQuery({
      dialect: 'postgres',
      sql: 'SELECT id FROM media',
      elapsedMs: 7,
      error: new Error('connection terminated')
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const duration = collected.get('foldergram.db.query.duration');
    expect(duration?.[0]?.attributes).toMatchObject({ status: 'error' });
  });

  it('opens a span with the same labels', () => {
    recordDbQuery({
      dialect: 'postgres',
      sql: 'SELECT id FROM media WHERE id = ?',
      elapsedMs: 42
    });

    const spans = spanExporter.getFinishedSpans();
    const span = spans.find((candidate) => candidate.name === 'db.query');

    expect(span).toBeDefined();
    expect(span?.attributes).toMatchObject({
      'db.system': 'postgresql',
      'db.operation': 'SELECT',
      'db.sql.table': 'media',
      'db.duration_ms': 42,
      'db.status': 'ok'
    });
  });
});
