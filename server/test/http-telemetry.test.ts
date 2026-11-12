import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordHttpRequest,
  resolveRoute,
  startHttpRequestSpan,
  statusClass
} from '../src/observability/http-telemetry.js';
import { recordDbQuery } from '../src/observability/db-telemetry.js';

interface MetricPoint {
  readonly attributes: Record<string, unknown>;
  readonly value: number;
}

function readValue(raw: unknown): number {
  if (typeof raw === 'number') {
    return raw;
  }

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

describe('http telemetry', () => {
  let exporter: InMemoryMetricExporter;
  let provider: MeterProvider;
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: TracerProvider;

  beforeEach(() => {
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
    // The spans hang from each other only when there is a context manager,
    // the same one the application installs when the telemetry starts.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    await tracerProvider.shutdown();
    trace.disable();
    context.disable();
  });

  it('groups the status by class', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(304)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
  });

  it('uses the route template, not the path that was requested', () => {
    expect(
      resolveRoute({ route: { path: '/folders/:slug' } }, '/api')
    ).toBe('/api/folders/:slug');

    // The router it is mounted on wins over the prefix.
    expect(
      resolveRoute({ baseUrl: '/api', route: { path: '/folders/:slug' } }, '/api')
    ).toBe('/api/folders/:slug');

    // The plugin routes carry their whole path already.
    expect(
      resolveRoute({ baseUrl: '/api', route: { path: '/api/plugins/ai-analysis/status' } }, '/api')
    ).toBe('/api/plugins/ai-analysis/status');

    // A request that matched no route.
    expect(resolveRoute({}, '/api')).toBe('unmatched');
  });

  it('records the duration of a request', async () => {
    recordHttpRequest({
      method: 'GET',
      route: '/api/folders',
      statusCode: 200,
      elapsedMs: 15
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const duration = collected.get('foldergram.http.request.duration');
    expect(duration).toHaveLength(1);
    expect(duration?.[0]?.value).toBe(15);
    expect(duration?.[0]?.attributes).toMatchObject({
      method: 'GET',
      route: '/api/folders',
      status_class: '2xx'
    });

    const count = collected.get('foldergram.http.request.count');
    expect(count?.[0]?.value).toBe(1);
  });

  it('opens a span that is closed with the route it matched', () => {
    const span = startHttpRequestSpan('GET', '/api/folders/42', () => {});
    span.finish('/api/folders/:id', 200, 15);

    const finished = spanExporter.getFinishedSpans();
    const request = finished.find((candidate) => candidate.name === 'http.request');

    expect(request).toBeDefined();
    expect(request?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/api/folders/:id',
      'http.response.status_code': 200,
      'http.duration_ms': 15
    });
  });

  it('runs the request inside the span, so the queries hang from it', () => {
    const span = startHttpRequestSpan('GET', '/api/folders', () => {
      recordDbQuery({
        dialect: 'postgres',
        sql: 'SELECT id FROM folders',
        elapsedMs: 12
      });
    });
    span.finish('/api/folders', 200, 20);

    const finished = spanExporter.getFinishedSpans();
    const request = finished.find((candidate) => candidate.name === 'http.request');
    const query = finished.find((candidate) => candidate.name === 'db.query');

    expect(query?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
  });

  it('marks a failed request as an error', () => {
    const span = startHttpRequestSpan('GET', '/api/folders', () => {});
    span.finish('/api/folders', 500, 3);

    const finished = spanExporter.getFinishedSpans();
    const request = finished.find((candidate) => candidate.name === 'http.request');

    expect(request?.status.code).toBe(2);
  });
});
