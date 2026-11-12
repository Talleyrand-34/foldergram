/**
 * Telemetry of the HTTP requests.
 *
 * Every request of the API opens a span, so the queries that ran during it
 * appear as its children in the trace. The time of the request is also
 * reported as a histogram, which is the number that answers "how slow is the
 * API?".
 *
 * The label of the route is the **route template** (`/folders/:slug`), not the
 * path that was requested (`/folders/my-holiday`). The path would create one
 * time series per folder name, per image, per anything.
 */

import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram
} from '@opentelemetry/api';

import { getInstruments } from './instruments.js';

const TRACER_NAME = 'foldergram.http';

export interface HttpRequestSample {
  /** The method of the request. */
  readonly method: string;
  /** The route template the request matched. */
  readonly route: string;
  /** The status the response carried. */
  readonly statusCode: number;
  /** How long the request took, in milliseconds. */
  readonly elapsedMs: number;
}

interface HttpInstruments {
  readonly duration: Histogram;
  readonly count: Counter;
}

function getHttpInstruments(): HttpInstruments {
  return getInstruments('http', (meter) => ({
    duration: meter.createHistogram('foldergram.http.request.duration', {
      description: 'How long an API request took, in milliseconds',
      unit: 'ms'
    }),
    count: meter.createCounter('foldergram.http.request.count', {
      description: 'API requests served, by method, route and status class'
    })
  }));
}

/** The status of a response, as a class. */
export function statusClass(statusCode: number): string {
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return '1xx';
}

/**
 * The route template a request matched.
 *
 * Express knows the route once the request has been dispatched, so the
 * template (`/folders/:slug`) is used instead of the path that was requested
 * (`/folders/my-holiday`): the path would create one time series per folder,
 * per image, per anything.
 *
 * A request that matched no route is reported as `unmatched`.
 *
 * @param request The request, once it has been dispatched.
 * @param prefix The path the router is mounted on, used when the request does
 * not carry one.
 */
export function resolveRoute(
  request: { baseUrl?: string; route?: { path?: unknown } },
  prefix = ''
): string {
  const path = request.route?.path;

  if (typeof path !== 'string' || path.length === 0) {
    return 'unmatched';
  }

  const base = request.baseUrl && request.baseUrl.length > 0 ? request.baseUrl : prefix;

  // The plugin routes are registered with their whole path (`/api/plugins/…`),
  // so the base is already part of it.
  if (base && (path === base || path.startsWith(`${base}/`))) {
    return path;
  }

  return `${base}${path}`;
}

/**
 * Records one request.
 *
 * It never throws: a broken measurement must not break the response.
 */
export function recordHttpRequest(sample: HttpRequestSample): void {
  try {
    const labels: Attributes = {
      method: sample.method,
      route: sample.route,
      status_class: statusClass(sample.statusCode)
    };

    const { duration, count } = getHttpInstruments();
    count.add(1, labels);
    duration.record(sample.elapsedMs, labels);
  } catch {
    // The measurement is best effort.
  }
}

/**
 * The span of a request that is running.
 *
 * With the telemetry off this returns a handle that does nothing: the Open
 * Tracing API hands out a non-recording span, so the cost is a function call.
 */
export interface HttpRequestSpan {
  /** Closes the span with the outcome of the request. */
  finish(route: string, statusCode: number, elapsedMs: number): void;
}

/**
 * Opens the span of a request and runs the request inside it.
 *
 * The route is not known yet when the request starts (the router has not
 * matched it), so it is closed with the route it ended up matching.
 *
 * The span becomes the active context while the request runs, so the queries
 * that run during it are its children in the trace.
 *
 * @param method The method of the request.
 * @param path The path that was requested.
 * @param next The rest of the request. It runs inside the span.
 */
export function startHttpRequestSpan(method: string, path: string, next: () => void): HttpRequestSpan {
  const tracer = trace.getTracer(TRACER_NAME);

  const span = tracer.startSpan('http.request', {
    attributes: {
      'http.request.method': method,
      'url.path': path
    }
  });

  context.with(trace.setSpan(context.active(), span), next);

  return {
    finish(route: string, statusCode: number, elapsedMs: number): void {
      try {
        span.setAttribute('http.route', route);
        span.setAttribute('http.response.status_code', statusCode);
        span.setAttribute('http.duration_ms', elapsedMs);

        if (statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch {
        // The measurement is best effort.
      }
    }
  };
}
