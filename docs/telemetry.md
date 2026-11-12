# Telemetry

Foldergram can report how it consumes its AI resources as **OpenTelemetry
metrics and traces**. The numbers leave the application and land in whatever
the operator already runs - an OpenTelemetry Collector, Prometheus, Grafana, a
hosted backend - instead of in a chart inside the app.

This document explains the shape of the data, how to turn it on, and how to
connect each piece so the numbers end up somewhere readable.

Nothing leaves the machine unless telemetry is configured. With no exporter
the OpenTelemetry API hands out no-op instruments and the cost is a function
call.

## Architecture

```
┌────────────────────┐   OTLP/HTTP    ┌─────────────────────┐   Prometheus     ┌────────────┐
│    Foldergram      │  POST /v1/     │  OpenTelemetry      │   scrape :8889  │ Prometheus │
│    (server)        │  metrics      │  Collector          │ ───────────────▶│ / Grafana  │
│                    │──────▶         │  (otelcol)          │                 └────────────┘
│  • AI metrics      │  POST /v1/     │                     │   OTLP/gRPC
│  • AI traces       │  traces       │                     │────────────────▶ Tempo / Grafana Cloud
└────────────────────┘                └─────────────────────┘
```

The application only speaks OTLP. It does not know nor care what is on the
other side. That is the point: the Collector is the translation layer, and it
can be replaced without touching Foldergram.

Three pieces, each optional from the application's point of view:

| Piece | What it does | Where it is |
| --- | --- | --- |
| The application | Produces the metrics and the traces | `server/src/observability/telemetry.ts` |
| The Collector | Receives OTLP, fans it out | `/opt/otelcol/` on the production host |
| The backend | Stores and shows the data | Prometheus, Grafana, Tempo, Loki, ... |

The application can also talk directly to a backend that speaks OTLP, without
a Collector in between. The Collector is only needed when the data has to be
split, buffered or translated (OTLP to Prometheus, for example).

## Turning it on

The application honours the standard OpenTelemetry environment variables, so
an existing Collector setup works without changes.

| Variable | Meaning |
| --- | --- |
| `TELEMETRY_ENABLED=1` | Turns telemetry on explicitly. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for metrics and traces, for example `http://127.0.0.1:4318`. |
| `OTEL_METRICS_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for the metrics only. |
| `OTEL_TRACES_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for the traces only. |
| `OTEL_SERVICE_NAME` | Service name in the backend. Defaults to `foldergram`. |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, for example `env=production,host=box`. |
| `OTEL_METRIC_EXPORT_INTERVAL` | How often the metrics are pushed, in milliseconds. Defaults to `15000`. |

Telemetry is **off** unless `TELEMETRY_ENABLED=1` or one of the OTLP endpoint
variables is set. That is deliberate: a deployment with no Collector should
not spam connection errors in the journal.

### On the production host (CT 144)

The application is a systemd service, so the variables go in a drop-in
instead of editing the unit:

```bash
mkdir -p /etc/systemd/system/foldergram.service.d
cat > /etc/systemd/system/foldergram.service.d/telemetry.conf <<'CONF'
[Service]
Environment=TELEMETRY_ENABLED=1
Environment=OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
Environment=OTEL_SERVICE_NAME=foldergram
Environment=OTEL_RESOURCE_ATTRIBUTES=env=production,host=foldergram-c
Environment=OTEL_METRIC_EXPORT_INTERVAL=15000
CONF
systemctl daemon-reload
systemctl restart foldergram
```

Check that the service picked them up:

```bash
systemctl show foldergram -p Environment --value | tr ' ' '\n' | grep -E 'TELEMETRY|OTEL'
```

### The Collector

The Collector runs as its own service:

| Path | What it is |
| --- | --- |
| `/opt/otelcol/otelcol` | The binary (OpenTelemetry Collector v0.165.0). |
| `/opt/otelcol/config.yaml` | Its configuration. |
| `/etc/systemd/system/otelcol.service` | The systemd unit. |

```bash
systemctl status otelcol
curl -s http://127.0.0.1:13133/          # health check
curl -s http://127.0.0.1:8889/metrics    # the Prometheus endpoint
```

The configuration it runs with:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
      grpc:
        endpoint: 127.0.0.1:4317

processors:
  memory_limiter:
    check_interval: 10s
    limit_mib: 256
    spike_limit_mib: 64
  batch:
    timeout: 5s

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
    resource_to_telemetry_conversion:
      enabled: true
  debug:
    verbosity: basic

extensions:
  health_check:
    endpoint: 127.0.0.1:13133

service:
  extensions: [health_check]
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus, debug]
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug]
  telemetry:
    logs:
      level: info
```

Two things worth knowing about it:

- The OTLP receiver only listens on `127.0.0.1`, so only the application on
  the same host can push to it. To accept data from other machines, bind it
  to `0.0.0.0` and protect it with a firewall or with an authenticating
  extension.
- The `batch` processor holds the data for up to 5 seconds before handing it
  to the exporters. A metric that was just produced takes up to 5 seconds to
  show up in `/metrics`. That is normal, not a bug.

To change the configuration:

```bash
/opt/otelcol/otelcol --config=/opt/otelcol/config.yaml --dry-run   # check it
systemctl restart otelcol
```

## The metrics

All the metrics are under the `foldergram.ai` namespace. They are emitted by
the AI analysis plugin at the same place where the analysis event is
recorded, so the metrics and the `ai_analysis_events` table cannot disagree.

### Names

The OpenTelemetry names and the Prometheus names are different, and the
difference follows a fixed rule: dots become underscores, the unit `ms`
becomes `_milliseconds`, and a counter gets a `_total` suffix.

| OpenTelemetry name | Prometheus name | Type | Labels |
| --- | --- | --- | --- |
| `foldergram.ai.analyses` | `foldergram_ai_analyses_total` | counter | `provider`, `model`, `status` |
| `foldergram.ai.analysis.duration` | `foldergram_ai_analysis_duration_milliseconds_{bucket,sum,count}` | histogram (ms) | `provider`, `model`, `status` |
| `foldergram.ai.stage.duration` | `foldergram_ai_stage_duration_milliseconds_{bucket,sum,count}` | histogram (ms) | `provider`, `stage` |
| `foldergram.ai.tokens` | `foldergram_ai_tokens_total` | counter | `provider`, `model`, `direction` |
| `foldergram.ai.errors` | `foldergram_ai_errors_total` | counter | `provider`, `error_kind` |
| `foldergram.ai.queue.depth` | `foldergram_ai_queue_depth` | up-down counter | - |
| `foldergram.ai.pauses` | `foldergram_ai_pauses_total` | counter | `provider`, `cause` |

The queue depth has **no** `_total`: it is an up-down counter, so its value
is the current depth and not a growing sum.

### What each one answers

- **`foldergram_ai_analyses_total`** - how many analyses ran, with which
  provider and model, and how they ended. `status` is `completed` or
  `failed`.
- **`foldergram_ai_analysis_duration_milliseconds`** - how long an analysis
  takes. Use the `_bucket` series for quantiles.
- **`foldergram_ai_stage_duration_milliseconds`** - where the time goes.
  `stage` is one of `frames`, `audio`, `transcribe`, `llm`. Only the stages
  that actually ran are recorded.
- **`foldergram_ai_tokens_total`** - how many tokens were spent.
  `direction` is `input` or `output`. **This is the number that decides the
  budget.**
- **`foldergram_ai_errors_total`** - which failures happen and how often.
  `error_kind` is one of `upstream_unavailable`, `rate_limited`,
  `llm_request_failed`, `llm_json_parse_failed`, `unexpected_exception`.
- **`foldergram_ai_queue_depth`** - how much work is waiting. The count comes
  from the database, where the real backlog lives, and it is read every five
  minutes: counting the pending videos is a scan over the whole library, so
  it is not done on every tick.
- **`foldergram_ai_pauses_total`** - why the queue stopped. `cause` is one of
  `manual`, `upstream`, `upstream_quota`, `rate_limit`, `usage_limit`,
  `shared_plan`.

  | Cause | What it means | Does it lift by itself? |
  | --- | --- | --- |
  | `manual` | An operator paused the queue | No, `POST /resume` is needed |
  | `rate_limit` | The upstream answered `429` | Yes, when the window ends |
  | `upstream_quota` | The upstream's credit or allowance ran out | Yes, after a cooldown |
  | `upstream` | The upstream is unusable - bad key, missing model | No, an operator must fix it |
  | `usage_limit` | The local budget window was exhausted | Yes, when the window resets |
  | `shared_plan` | Somebody else is in the shared plan pool | Yes, when the pool frees up |

  The `provider` label names the provider that caused the pause. It is
  `unknown` only for a manual pause, which belongs to no provider.

### Labels that come from the resource

On top of the labels above, every series carries the resource attributes and
the scope metadata. On the production host:

```
foldergram_ai_analyses_total{env="production",host="foldergram-c",job="foldergram",model="MiniMax-M3.1-Flash",otel_scope_name="foldergram",otel_scope_schema_url="",otel_scope_version="",provider="minimax",service_name="foldergram",service_version="0.0.0",status="failed"} 1
```

- `env` and `host` come from `OTEL_RESOURCE_ATTRIBUTES`.
- `job` comes from `service.name`, through the Collector's
  `resource_to_telemetry_conversion`.
- `service_name` and `service_version` are the resource attributes.
- `otel_scope_*` identify the instrumentation scope.

### What is deliberately missing

The **media id and the folder id are not metric labels**. They would make
every series unique - one time series per video - and blow up the backend.
They are attributes of the trace instead, where they belong. The metric
labels are bounded: a provider, a model, a status, a stage, a direction, a
cause.

## The traces

Every analysis opens an `ai.analysis` span, and every stage that ran opens a
child span.

| Span | Attributes |
| --- | --- |
| `ai.analysis` | `ai.image_id`, `ai.folder_id`, `ai.provider`, `ai.model`, `ai.outcome`, `ai.error_kind` (only on failure) |
| `ai.stage.frames` | `ai.stage`, `ai.duration_ms` |
| `ai.stage.audio` | `ai.stage`, `ai.duration_ms` |
| `ai.stage.transcribe` | `ai.stage`, `ai.duration_ms` |
| `ai.stage.llm` | `ai.stage`, `ai.duration_ms` |

`ai.outcome` is `completed`, `failed` or `skipped`. A failed analysis has
`ai.error_kind` and the span status is `ERROR`.

The stage spans are given a start time in the past, because the stage is
timed somewhere else: that is the only way to turn a measured duration into a
span that sits where it belongs in the tree.

The trace is where the ids live. It is also the only way to tie a single
analysis to its media, which is what you need when a specific video comes
back with a bad summary.

## Reading the data with PromQL

The examples below assume Prometheus is scraping the Collector on
`10.0.36.37:8889`.

**Token spend per provider and model** - the budget number:

```text
sum by (provider, model) (rate(foldergram_ai_tokens_total[5m]))
```

**Input vs output tokens:**

```text
sum by (direction) (rate(foldergram_ai_tokens_total[5m]))
```

**Analyses per hour, split by outcome:**

```text
sum by (status) (rate(foldergram_ai_analyses_total[1h]))
```

**p95 latency of an analysis:**

```text
histogram_quantile(0.95, sum by (le) (rate(foldergram_ai_analysis_duration_milliseconds_bucket[5m])))
```

**Where the time goes, per stage:**

```text
histogram_quantile(0.95, sum by (le, stage) (rate(foldergram_ai_stage_duration_milliseconds_bucket[5m])))
```

**Error rate, by reason:**

```text
sum by (error_kind) (rate(foldergram_ai_errors_total[5m]))
```

**Share of analyses that failed:**

```text
sum(rate(foldergram_ai_errors_total[15m])) / sum(rate(foldergram_ai_analyses_total[15m]))
```

**How much work is waiting:**

```text
foldergram_ai_queue_depth
```

It is an up-down counter, so the value is the current depth and not a
growing total. It is refreshed every five minutes.

**Why the queue stopped:**

```text
sum by (cause) (increase(foldergram_ai_pauses_total[24h]))
```

**Alert: the provider is out of credit.** The upstream answers `402` and the
queue pauses on its own. The metric makes it visible without reading the
journal:

```text
increase(foldergram_ai_pauses_total{cause="upstream_quota"}[1h]) > 0
```

## Connecting Prometheus

Prometheus scrapes the Collector. It never talks to the application
directly.

```yaml
# /etc/prometheus/prometheus.yml
scrape_configs:
  - job_name: 'foldergram'
    scrape_interval: 15s
    static_configs:
      - targets: ['10.0.36.37:8889']
```

The Collector is a pull target like any other exporter. The names it serves
are the ones in the table above.

After reloading Prometheus, check that the series arrived:

```text
count({job="foldergram"})
```

## Connecting Grafana

1. **Data source**: add a Prometheus data source pointing at the Prometheus
   that scrapes the Collector (`http://prometheus:9090`). If Grafana and
   Prometheus are on the same host, use `http://127.0.0.1:9090`.
2. **Dashboard**: create a dashboard for the AI usage. The panels that make
   sense are the ones above:
   - *Token spend*: `sum by (provider, model) (rate(foldergram_ai_tokens_total[5m]))`
   - *Analyses*: `sum by (status) (rate(foldergram_ai_analyses_total[5m]))`
   - *p95 latency*: the `histogram_quantile` above
   - *Time per stage*: the `histogram_quantile` by stage
   - *Errors*: `sum by (error_kind) (rate(foldergram_ai_errors_total[5m]))`
   - *Queue depth*: `foldergram_ai_queue_depth`
   - *Pauses*: `sum by (cause) (increase(foldergram_ai_pauses_total[24h]))`
3. **Units**: set the unit of the token panels to `short` and the latency
   panels to `milliseconds`, so Grafana formats them.

## Sending the data somewhere else

The Collector is where the fan-out happens. To send the data onward, add an
exporter to `/opt/otelcol/config.yaml` and put it in the pipeline.

**To Grafana Cloud (OTLP)**:

```yaml
exporters:
  otlphttp/grafana:
    endpoint: https://otlp-gateway-prod-eu-west-0.grafana.net/otlp
    headers:
      Authorization: Basic <base64 of instance:token>
    tls:
      insecure: false

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus, otlphttp/grafana]
```

**To Tempo (traces)**:

```yaml
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [debug, otlp/tempo]
```

**To Loki (logs)** - not for these metrics, which are not logs, but for the
Collector's own output:

```yaml
exporters:
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
```

After changing the configuration, validate it before restarting:

```bash
/opt/otelcol/otelcol --config=/opt/otelcol/config.yaml --dry-run
systemctl restart otelcol
journalctl -u otelcol -n 50 --no-pager
```

If the Collector cannot reach the new backend, it retries and keeps the
metrics it already had; the application is not affected either way, because
the application only talks to the Collector.

## Verifying that it works

End to end, from the application to the backend:

```bash
# 1. the service has the variables
systemctl show foldergram -p Environment --value | tr ' ' '\n' | grep -E 'TELEMETRY|OTEL'

# 2. the Collector is alive
curl -s http://127.0.0.1:13133/

# 3. the data reaches the Collector
curl -s http://127.0.0.1:8889/metrics | grep '^foldergram_ai'

# 4. the traces reach the Collector
journalctl -u otelcol --since '-5 minutes' --no-pager | grep -i 'Traces'
```

On the application's side, the journal must stay quiet. The exporter logs a
failure if it cannot push:

```bash
journalctl -u foldergram --since '-1 hour' --no-pager | grep -i 'telemetry'
```

## Troubleshooting

**No series in `/metrics`.** The application is not pushing, or it is
pushing somewhere else. Check that the service has the variables
(`systemctl show foldergram -p Environment`), that the endpoint matches the
Collector's OTLP receiver, and that the Collector's OTLP receiver is
actually listening (`ss -ltn | grep 4318`).

**The metrics show up late.** The `batch` processor waits up to 5 seconds.
Wait a few seconds and scrape again.

**The service does not start after changing the unit.** Run
`systemd-analyze verify /etc/systemd/system/foldergram.service` and read
the warning. This systemd build rejects `Restart=unless-stopped`: the
directive is ignored, the service ends up with `Restart=no`, and it stays
down after a crash. Use `Restart=always`.

**The exporter complains in the journal.** The application logs
`[telemetry] could not start the metrics pipeline: ...` when it cannot set
up the exporters, and the OTLP exporter logs a failure on every push it
cannot deliver. Both point at the endpoint: check the URL, and check that
nothing is listening on the other side.

**The queue is paused and nothing is being analysed.** The pauses metric says
why. `cause="upstream_quota"` with a growing
`foldergram_ai_errors_total{error_kind="upstream_unavailable"}` means the
provider is refusing the requests - on the production host that was the
upstream answering `402 The Token Plan usage limit has been reached`, which
is a credit problem, not a bug in the application. `cause="manual"` means an
operator paused it, and `cause="upstream"` means the upstream needs a human
(bad key, missing model).

**Too many series.** The media and folder ids are not labels, so the number
of series is bounded by the number of providers, models and stages. If the
count grows anyway, something else is being scraped with more labels than
expected - check the full series list before assuming the application is at
fault.

## Where the code is

| File | What it holds |
| --- | --- |
| `server/src/observability/telemetry.ts` | The exporter setup and the AI metric facade (`recordAiUsage`, `recordAiQueueDepth`, `recordAiPause`, `startAiAnalysisSpan`). |
| `server/src/index.ts` | Starts the pipeline at boot, flushes it on shutdown. |
| `plugins/ai-analysis/src/storage.ts` | Emits the usage of every analysis. |
| `plugins/ai-analysis/src/analyzer.ts` | Opens the trace and the stage spans. |
| `plugins/ai-analysis/src/worker.ts` | Emits the queue depth and the pauses. |
| `server/test/telemetry.test.ts` | The tests of both the metrics and the traces. |
