/**
 * OpenTelemetry wiring for the application.
 *
 * The point of this module is to expose how the AI resources are consumed
 * (tokens, time, failures, queue depth) as telemetry, so the numbers end up in
 * whatever the operator already runs - an OpenTelemetry Collector, Prometheus,
 * Grafana, a hosted backend - instead of in a chart inside the app.
 *
 * Nothing is sent unless telemetry is configured: with no exporter the
 * OpenTelemetry API hands out no-op instruments and the cost is a function
 * call.
 *
 * Configuration (the standard OpenTelemetry variables are honoured):
 *
 *   TELEMETRY_ENABLED=1                 turn it on explicitly
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
 *   OTEL_METRICS_EXPORTER_OTLP_ENDPOINT=http://collector:4318/v1/metrics
 *   OTEL_TRACES_EXPORTER_OTLP_ENDPOINT=http://collector:4318/v1/traces
 *   OTEL_SERVICE_NAME=foldergram        name of the service in the backend
 *   OTEL_RESOURCE_ATTRIBUTES=env=prod,host=box
 *   OTEL_METRIC_EXPORT_INTERVAL=15000   how often the metrics are pushed
 */

import { context, metrics, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

const SCOPE_NAME = 'foldergram';
const TRACER_NAME = 'foldergram.ai';

export interface AiUsageSample {
  /** The provider the analysis spent from. */
  readonly providerId: string | null;
  /** The model that answered. */
  readonly model: string | null;
  /** Whether the analysis finished or failed. */
  readonly status: 'completed' | 'failed';
  /** The media that was analyzed. Never used as a metric label. */
  readonly imageId: number | null;
  /** The folder the media belongs to. Never used as a metric label. */
  readonly folderId: number | null;
  readonly durationMs: number;
  readonly frameExtractMs: number;
  readonly audioExtractMs: number;
  readonly whisperMs: number;
  readonly llmMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly errorKind: string | null;
}

export interface AiPauseSample {
  readonly providerId: string | null;
  readonly cause: string;
}

let meterProvider: MeterProvider | null = null;
let tracerProvider: TracerProvider | null = null;
let started = false;

/**
 * Whether telemetry is configured.
 *
 * An explicit `TELEMETRY_ENABLED=1` always turns it on; otherwise any OTLP
 * endpoint turns it on.
 */
export function isTelemetryEnabled(): boolean {
  if ((process.env.TELEMETRY_ENABLED ?? '').trim() === '1') {
    return true;
  }

  return ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_METRICS_EXPORTER_OTLP_ENDPOINT', 'OTEL_TRACES_EXPORTER_OTLP_ENDPOINT']
    .some((name) => (process.env[name] ?? '').trim().length > 0);
}

/**
 * The extra resource attributes, as `OTEL_RESOURCE_ATTRIBUTES` declares them.
 *
 * The same attributes are used as the tags of the profiles, so a profile and
 * a metric of the same service can be told apart the same way.
 */
export function readResourceAttributes(): Record<string, string> {
  const extra = (process.env.OTEL_RESOURCE_ATTRIBUTES ?? '')
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const index = pair.indexOf('=');
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
    });

  return Object.fromEntries(extra);
}

function buildResource() {
  const serviceName = (process.env.OTEL_SERVICE_NAME ?? 'foldergram').trim() || 'foldergram';

  return resourceFromAttributes({
    'service.name': serviceName,
    'service.version': process.env.npm_package_version ?? '0.0.0',
    ...readResourceAttributes()
  });
}

/**
 * Starts the telemetry pipeline.
 *
 * It is safe to call it more than once: the second call does nothing.
 */
export function startTelemetry(): void {
  if (started || !isTelemetryEnabled()) {
    return;
  }

  started = true;

  const resource = buildResource();

  try {
    const meter = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: readExportInterval()
        })
      ]
    });

    metrics.setGlobalMeterProvider(meter);
    meterProvider = meter;
  } catch (error) {
    logTelemetryError('metrics', error);
  }

  try {
    const tracer = new TracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]
    });

    trace.setGlobalTracerProvider(tracer);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    tracerProvider = tracer;
  } catch (error) {
    logTelemetryError('traces', error);
  }
}

/**
 * Flushes and stops the telemetry pipeline. Called on shutdown so the last
 * batch is not lost.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!started) {
    return;
  }

  started = false;

  await Promise.allSettled([
    meterProvider?.shutdown() ?? Promise.resolve(),
    tracerProvider?.shutdown() ?? Promise.resolve()
  ]);

  meterProvider = null;
  tracerProvider = null;
}

function readExportInterval(): number {
  const configured = Number.parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? '', 10);

  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return 15_000;
}

function logTelemetryError(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[telemetry] could not start the ${kind} pipeline: ${message}`);
}

// ---------------------------------------------------------------------------
// AI usage
// ---------------------------------------------------------------------------

interface AiInstruments {
  analyses: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  duration: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  stageDuration: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>;
  tokens: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  errors: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  queueDepth: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
  pauses: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']>;
  concurrency: ReturnType<ReturnType<typeof metrics.getMeter>['createUpDownCounter']>;
}

let instruments: AiInstruments | null = null;
let instrumentsProvider: unknown = null;
/** The last queue depth that was published, to turn it into a delta. */
let lastQueueDepth = 0;
/**
 * The last concurrency that was published, to turn it into a delta.
 *
 * It starts at zero, like the counter itself: the sum of the deltas has to
 * be the number of workers, not the number of changes.
 */
let lastConcurrency = 0;

function getInstruments(): AiInstruments {
  const provider = metrics.getMeterProvider();

  // The instruments are bound to the provider that was active when they were
  // created. If the provider is replaced (the pipeline starts late, or the
  // tests install a new one), they have to be created again, or they would
  // keep reporting to a provider nobody reads.
  if (instruments && instrumentsProvider === provider) {
    return instruments;
  }

  const meter = metrics.getMeter(SCOPE_NAME);

  instruments = {
    analyses: meter.createCounter('foldergram.ai.analyses', {
      description: 'AI analyses performed, by provider, model and outcome'
    }),
    duration: meter.createHistogram('foldergram.ai.analysis.duration', {
      description: 'How long an AI analysis took, in milliseconds',
      unit: 'ms'
    }),
    stageDuration: meter.createHistogram('foldergram.ai.stage.duration', {
      description: 'How long each stage of an AI analysis took, in milliseconds',
      unit: 'ms'
    }),
    tokens: meter.createCounter('foldergram.ai.tokens', {
      description: 'Tokens spent on AI analyses, by provider, model and direction'
    }),
    errors: meter.createCounter('foldergram.ai.errors', {
      description: 'AI analyses that failed, by provider and reason'
    }),
    queueDepth: meter.createUpDownCounter('foldergram.ai.queue.depth', {
      description: 'Videos waiting in the AI analysis queue'
    }),
    pauses: meter.createCounter('foldergram.ai.pauses', {
      description: 'Times the AI queue was paused, by cause'
    }),
    concurrency: meter.createUpDownCounter('foldergram.ai.analysis.concurrency', {
      description: 'How many videos are analysed at the same time'
    })
  };
  instrumentsProvider = provider;
  // A new provider starts from zero, so the delta that brings the counter
  // back to the real depth is computed against zero.
  lastQueueDepth = 0;

  return instruments;
}

/**
 * Records one AI analysis.
 *
 * The media and folder ids are deliberately left out of the labels: they would
 * make the time series unique per video and blow up the backend. They go into
 * the trace instead, where they belong.
 */
export function recordAiUsage(sample: AiUsageSample): void {
  const provider = sample.providerId ?? 'unknown';
  const model = sample.model ?? 'unknown';

  const labels: Attributes = {
    provider,
    model,
    status: sample.status
  };

  try {
    const { analyses, duration, stageDuration, tokens, errors } = getInstruments();

    analyses.add(1, labels);
    duration.record(sample.durationMs, labels);

    const stages: Array<[string, number]> = [
      ['frames', sample.frameExtractMs],
      ['audio', sample.audioExtractMs],
      ['transcribe', sample.whisperMs],
      ['llm', sample.llmMs]
    ];

    for (const [stage, elapsed] of stages) {
      if (elapsed > 0) {
        stageDuration.record(elapsed, { provider, stage });
      }
    }

    if (sample.inputTokens > 0) {
      tokens.add(sample.inputTokens, { provider, model, direction: 'input' });
    }

    if (sample.outputTokens > 0) {
      tokens.add(sample.outputTokens, { provider, model, direction: 'output' });
    }

    if (sample.status === 'failed') {
      errors.add(1, { provider, error_kind: sample.errorKind ?? 'unknown' });
    }
  } catch (error) {
    logTelemetryError('metrics', error);
  }
}

/**
 * Publishes how many videos are being analysed at the same time.
 *
 * The number follows the room the plan leaves: more when the plan has
 * room to spare, less when going faster would exhaust it before its
 * window renews.
 */
export function setAiConcurrency(value: number): void {
  const concurrency = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;

  try {
    getInstruments().concurrency.add(concurrency - lastConcurrency);
    lastConcurrency = concurrency;
  } catch (error) {
    logTelemetryError('metrics', error);
  }
}

/**
 * Publishes the current AI queue depth.
 *
 * The depth is read from the database, where the real queue lives, so it is
 * published as an absolute value. The up-down counter needs a delta, so the
 * difference with the last published value is what gets added.
 */
export function setAiQueueDepth(value: number): void {
  const depth = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const delta = depth - lastQueueDepth;

  if (delta === 0) {
    return;
  }

  try {
    getInstruments().queueDepth.add(delta);
    lastQueueDepth = depth;
  } catch (error) {
    logTelemetryError('metrics', error);
  }
}

/** Records that the AI queue was paused. */
export function recordAiPause(sample: AiPauseSample): void {
  try {
    getInstruments().pauses.add(1, {
      provider: sample.providerId ?? 'unknown',
      cause: sample.cause
    });
  } catch (error) {
    logTelemetryError('metrics', error);
  }
}

/**
 * A trace of one AI analysis.
 *
 * The span carries the ids and the outcome, which is what the metrics cannot
 * carry without exploding the cardinality.
 */
export interface AiAnalysisTrace {
  /**
   * Records one stage of the analysis as a child span.
   *
   * The stage is timed somewhere else, so the child span is given a start
   * time in the past: that is the only way to turn a measured duration into
   * a span that sits where it belongs in the trace.
   */
  stage(name: string, elapsedMs: number): void;
  /** Closes the span with the outcome of the analysis. */
  finish(
    outcome: 'completed' | 'failed' | 'skipped',
    options?: { readonly errorKind?: string | null; readonly model?: string | null }
  ): void;
}

/**
 * Opens a span for one AI analysis.
 *
 * With telemetry off this returns a handle that does nothing: the Open
 * Tracing API hands out a non-recording span, so the cost is a function call.
 */
export function startAiAnalysisSpan(sample: {
  readonly imageId: number | null;
  readonly folderId: number | null;
  readonly providerId: string | null;
  readonly model: string | null;
}): AiAnalysisTrace {
  const tracer = trace.getTracer(TRACER_NAME);

  const root = tracer.startSpan('ai.analysis', {
    attributes: {
      'ai.image_id': sample.imageId,
      'ai.folder_id': sample.folderId,
      'ai.provider': sample.providerId ?? 'unknown',
      'ai.model': sample.model ?? 'unknown'
    }
  });

  // The stages are children of the analysis span, so the trace reads as a
  // tree instead of a flat list.
  const parent = trace.setSpan(context.active(), root);
  let finished = false;

  return {
    stage(name: string, elapsedMs: number): void {
      if (finished || elapsedMs <= 0) {
        return;
      }

      try {
        const end = Date.now();
        const child = tracer.startSpan(
          `ai.stage.${name}`,
          {
            startTime: end - elapsedMs,
            attributes: {
              'ai.stage': name,
              'ai.duration_ms': elapsedMs
            }
          },
          parent
        );

        child.end(end);
      } catch (error) {
        logTelemetryError('traces', error);
      }
    },

    finish(
      outcome: 'completed' | 'failed' | 'skipped',
      options?: { readonly errorKind?: string | null; readonly model?: string | null }
    ): void {
      if (finished) {
        return;
      }

      finished = true;

      try {
        if (options?.model) {
          root.setAttribute('ai.model', options.model);
        }

        root.setAttribute('ai.outcome', outcome);

        if (options?.errorKind) {
          root.setAttribute('ai.error_kind', options.errorKind);
        }

        if (outcome === 'failed') {
          root.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          root.setStatus({ code: SpanStatusCode.OK });
        }

        root.end();
      } catch (error) {
        logTelemetryError('traces', error);
      }
    }
  };
}
