import { metrics } from '@opentelemetry/api';
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isTelemetryEnabled,
  recordAiPause,
  recordAiQueueDepth,
  recordAiUsage
} from '../src/observability/telemetry.js';

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

describe('telemetry', () => {
  let exporter: InMemoryMetricExporter;
  let provider: MeterProvider;

  beforeEach(() => {
    // The global provider can only be set once per process, so it is reset
    // between the tests.
    metrics.disable();

    exporter = new InMemoryMetricExporter();
    provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 })]
    });

    metrics.setGlobalMeterProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
  });

  it('is off unless it is configured', () => {
    const previous = process.env.TELEMETRY_ENABLED;
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    delete process.env.TELEMETRY_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(isTelemetryEnabled()).toBe(false);

    process.env.TELEMETRY_ENABLED = '1';
    expect(isTelemetryEnabled()).toBe(true);

    delete process.env.TELEMETRY_ENABLED;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318';
    expect(isTelemetryEnabled()).toBe(true);

    if (previous === undefined) {
      delete process.env.TELEMETRY_ENABLED;
    } else {
      process.env.TELEMETRY_ENABLED = previous;
    }

    if (endpoint === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
    }
  });

  it('records an analysis with its provider, model, duration and tokens', async () => {
    recordAiUsage({
      providerId: 'minimax',
      model: 'minimax-m2',
      status: 'completed',
      imageId: 42,
      folderId: 7,
      durationMs: 1234,
      frameExtractMs: 100,
      audioExtractMs: 0,
      whisperMs: 200,
      llmMs: 900,
      inputTokens: 1500,
      outputTokens: 300,
      errorKind: null
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const analyses = collected.get('foldergram.ai.analyses');
    expect(analyses).toHaveLength(1);
    expect(analyses?.[0]?.value).toBe(1);
    expect(analyses?.[0]?.attributes).toMatchObject({ provider: 'minimax', model: 'minimax-m2', status: 'completed' });

    const duration = collected.get('foldergram.ai.analysis.duration');
    expect(duration?.[0]?.value).toBe(1234);

    // One point per stage that actually ran.
    const stages = collected.get('foldergram.ai.stage.duration') ?? [];
    expect(stages.map((point) => point.attributes.stage).sort()).toEqual(['frames', 'llm', 'transcribe']);

    const tokens = collected.get('foldergram.ai.tokens') ?? [];
    expect(tokens).toHaveLength(2);
    expect(tokens.map((point) => point.value).sort((a, b) => a - b)).toEqual([300, 1500]);
    expect(tokens.every((point) => point.attributes.provider === 'minimax')).toBe(true);
  });

  it('counts the failures with their reason', async () => {
    recordAiUsage({
      providerId: 'openai',
      model: 'gpt-4o',
      status: 'failed',
      imageId: 43,
      folderId: 8,
      durationMs: 10,
      frameExtractMs: 0,
      audioExtractMs: 0,
      whisperMs: 0,
      llmMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      errorKind: 'rate_limited'
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const errors = collected.get('foldergram.ai.errors');
    expect(errors).toHaveLength(1);
    expect(errors?.[0]?.attributes).toMatchObject({ provider: 'openai', error_kind: 'rate_limited' });
  });

  it('keeps the media ids out of the labels', async () => {
    recordAiUsage({
      providerId: 'minimax',
      model: 'minimax-m2',
      status: 'completed',
      imageId: 987654,
      folderId: 123456,
      durationMs: 5,
      frameExtractMs: 0,
      audioExtractMs: 0,
      whisperMs: 0,
      llmMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      errorKind: null
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    for (const points of collected.values()) {
      for (const point of points) {
        expect(point.attributes).not.toHaveProperty('image_id');
        expect(point.attributes).not.toHaveProperty('folder_id');
      }
    }
  });

  it('tracks the queue depth and the pauses', async () => {
    recordAiQueueDepth(1);
    recordAiQueueDepth(1);
    recordAiQueueDepth(-1);
    recordAiPause({ providerId: 'minimax', cause: 'rate_limit' });

    await provider.forceFlush();
    const collected = collect(exporter);

    const depth = collected.get('foldergram.ai.queue.depth');
    expect(depth?.reduce((total, point) => total + point.value, 0)).toBe(1);

    const pauses = collected.get('foldergram.ai.pauses');
    expect(pauses?.[0]?.value).toBe(1);
    expect(pauses?.[0]?.attributes).toMatchObject({ provider: 'minimax', cause: 'rate_limit' });
  });
});
