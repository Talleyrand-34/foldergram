import { metrics } from '@opentelemetry/api';
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordPlanState,
  resetPlanMetrics
} from '../src/observability/plan-metrics.js';

interface MetricPoint {
  readonly attributes: Record<string, unknown>;
  readonly value: number;
}

function collect(exporter: InMemoryMetricExporter): Map<string, MetricPoint[]> {
  const collected = new Map<string, MetricPoint[]>();

  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const points = metric.dataPoints.map((point) => ({
          attributes: (point as { attributes?: Record<string, unknown> }).attributes ?? {},
          value: (point as { value?: number }).value ?? 0
        }));

        collected.set(metric.descriptor.name, points);
      }
    }
  }

  return collected;
}

describe('the plan as metrics', () => {
  let exporter: InMemoryMetricExporter;
  let provider: MeterProvider;

  beforeEach(() => {
    metrics.disable();
    resetPlanMetrics();

    exporter = new InMemoryMetricExporter();
    provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 })]
    });

    metrics.setGlobalMeterProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    metrics.disable();
    resetPlanMetrics();
  });

  it('publishes what is left of every window of the plan', async () => {
    recordPlanState({
      providerId: 'minimax',
      contended: false,
      windows: [
        {
          kind: 'interval',
          remainingPercent: 87,
          hoursLeft: 42,
          rollsOverInSeconds: 7_200
        },
        {
          kind: 'weekly',
          remainingPercent: 67,
          hoursLeft: 31,
          rollsOverInSeconds: 414_000
        }
      ]
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const remaining = collected.get('foldergram.ai.plan.remaining');
    expect(remaining).toHaveLength(2);
    expect(remaining?.map((point) => point.attributes.window).sort()).toEqual([
      'interval',
      'weekly'
    ]);
    expect(remaining?.find((point) => point.attributes.window === 'interval')?.value).toBe(87);
    expect(remaining?.every((point) => point.attributes.provider === 'minimax')).toBe(true);

    const timeLeft = collected.get('foldergram.ai.plan.time_left');
    expect(timeLeft?.find((point) => point.attributes.window === 'weekly')?.value).toBe(31);

    const rollsOver = collected.get('foldergram.ai.plan.rolls_over_in');
    expect(rollsOver?.find((point) => point.attributes.window === 'interval')?.value).toBe(7_200);

    const contended = collected.get('foldergram.ai.plan.contended');
    expect(contended?.[0]?.value).toBe(0);
  });

  it('publishes the contention', async () => {
    recordPlanState({
      providerId: 'minimax',
      contended: true,
      windows: [
        {
          kind: 'interval',
          remainingPercent: 50,
          hoursLeft: null,
          rollsOverInSeconds: 600
        }
      ]
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    const contended = collected.get('foldergram.ai.plan.contended');
    expect(contended?.[0]?.value).toBe(1);
  });

  it('publishes the value and not the sum of the values', async () => {
    // The plan is published every couple of minutes and barely moves, so
    // the series has to hold the current value and not accumulate.
    for (const remainingPercent of [90, 88, 88, 85]) {
      recordPlanState({
        providerId: 'minimax',
        contended: false,
        windows: [
          {
            kind: 'interval',
            remainingPercent,
            hoursLeft: null,
            rollsOverInSeconds: 600
          }
        ]
      });
    }

    await provider.forceFlush();
    const collected = collect(exporter);

    const remaining = collected.get('foldergram.ai.plan.remaining');
    expect(remaining?.reduce((total, point) => total + point.value, 0)).toBe(85);
  });

  it('publishes nothing when there is no projection to publish', async () => {
    recordPlanState({
      providerId: 'minimax',
      contended: false,
      windows: [
        {
          kind: 'interval',
          remainingPercent: 100,
          hoursLeft: null,
          rollsOverInSeconds: 600
        }
      ]
    });

    await provider.forceFlush();
    const collected = collect(exporter);

    // The plan is not being spent, so there is no projection to publish.
    expect(collected.get('foldergram.ai.plan.time_left')).toBeUndefined();
  });
});
