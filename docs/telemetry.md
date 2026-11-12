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

The metrics come in two groups: the **AI usage** (`foldergram.ai.*`) and the
**runtime** (`foldergram.db.*` and `foldergram.http.*`).

The AI ones are emitted by the AI analysis plugin at the same place where the
analysis event is recorded, so the metrics and the `ai_analysis_events` table
cannot disagree. The runtime ones are emitted by the database drivers and by
the API middleware.

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
| `foldergram.ai.plan.remaining` | `foldergram_ai_plan_remaining_percent` | up-down counter | `provider`, `window` |
| `foldergram.ai.plan.time_left` | `foldergram_ai_plan_time_left_hours` | up-down counter | `provider`, `window` |
| `foldergram.ai.plan.rolls_over_in` | `foldergram_ai_plan_rolls_over_in_seconds` | up-down counter | `provider`, `window` |
| `foldergram.ai.plan.contended` | `foldergram_ai_plan_contended` | up-down counter | `provider` |
| `foldergram.db.query.duration` | `foldergram_db_query_duration_milliseconds_{bucket,sum,count}` | histogram (ms) | `dialect`, `operation`, `table`, `status` |
| `foldergram.db.query.count` | `foldergram_db_query_count_total` | counter | `dialect`, `operation`, `table`, `status` |
| `foldergram.http.request.duration` | `foldergram_http_request_duration_milliseconds_{bucket,sum,count}` | histogram (ms) | `method`, `route`, `status_class` |
| `foldergram.http.request.count` | `foldergram_http_request_count_total` | counter | `method`, `route`, `status_class` |

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
  | `usage_limit` | The plan's own wall: a window has no room left | Yes, when the window rolls over |
  | `shared_plan` | Somebody else is in the shared plan pool | Yes, when the pool frees up |

  The `provider` label names the provider that caused the pause. It is
  `unknown` only for a manual pause, which belongs to no provider.
- **`foldergram_ai_plan_remaining_percent`** - how much of each window of
  the plan is left, as the provider publishes it. `window` is `interval`
  (the plan's five-hour window) or `weekly` (its week). **This is the
  limit the queue obeys.**
- **`foldergram_ai_plan_time_left_hours`** - how long each window lasts at
  the rate it is being spent. It is what is left divided by how fast the
  plan is going, which is the answer to "when does this run out". The
  window that renews first is the limit, because what is not spent is
  lost: the plan does not carry the remainder over.

  The rate is measured two ways, and the recent one wins: between the
  oldest and the newest reading of the same window, and — when there is
  no history to measure that with — the average over the whole window,
  from the moment it opened (the plan is whole then). The readings are
  kept in the database, so the rate survives a restart.

  It is published only when the measurement has enough signal: the plan
  publishes whole percentages, so a rate that rests on one point can be
  wrong by a hundred per cent.
- **`foldergram_ai_plan_rolls_over_in_seconds`** - how long until each
  window rolls over and the plan is whole again.
- **`foldergram_ai_plan_contended`** - whether somebody else is using the
  plan. It is `1` while the pool moves without any of ours being sent. The
  queue takes only its share while that is so.

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

The same goes for the SQL statement: it is never a label. One series per
statement would be one series per query in the code.

### The runtime metrics

- **`foldergram_db_query_duration_milliseconds`** - how long the database
  takes. `operation` is the verb of the statement (`SELECT`, `INSERT`,
  `UPDATE`, `DELETE`, `WITH`, ...) and `table` is the first table it touches.
  `dialect` is `postgres` or `sqlite` and `status` is `ok` or `error`.
- **`foldergram_db_query_count_total`** - how many queries run, and how many
  of them fail. A query that throws is measured too: it is not a query that
  does not exist.
- **`foldergram_http_request_duration_milliseconds`** - how long the API
  takes, per route. `route` is the route **template**
  (`/api/folders/:slug`), never the path that was requested.
- **`foldergram_http_request_count_total`** - how many requests are served,
  and how many of them fail (`status_class` is `2xx`, `3xx`, `4xx`, `5xx`).

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
| `http.request` | `http.request.method`, `url.path`, `http.route`, `http.response.status_code`, `http.duration_ms` |
| `db.query` | `db.system`, `db.operation`, `db.sql.table`, `db.duration_ms`, `db.status` |

`ai.outcome` is `completed`, `failed` or `skipped`. A failed analysis has
`ai.error_kind` and the span status is `ERROR`.

The stage spans are given a start time in the past, because the stage is
timed somewhere else: that is the only way to turn a measured duration into a
span that sits where it belongs in the tree.

The trace is where the ids live. It is also the only way to tie a single
analysis to its media, which is what you need when a specific video comes
back with a bad summary.

### The request and its queries

Every API request opens an `http.request` span, and the request runs inside
it, so the queries that run during the request are its children:

```
http.request  http.route=/api/feed  http.duration_ms=783
├── db.query   db.operation=SELECT  db.sql.table=images  db.duration_ms=507
└── db.query   db.operation=SELECT  db.sql.table=images  db.duration_ms=267
```

That tree is the answer to "what was this request waiting for?". The
`db.query` spans of the work that runs outside a request (the scanner, the AI
worker) are roots of their own trace, which is also how they are found.

The queries are measured next to the query itself, in the driver, so the
measurement covers the round trip to PostgreSQL and not only the time the
application spends with the result.

## Where the limit comes from

The queue does not stop because a number was typed into the settings. When
the provider publishes its plan, **the plan's own wall is the limit**:

- the plan is read from its read-only endpoint. MiniMax publishes it at
  `/v1/token_plan/remains`, and it reports how much of each window is left -
  a five-hour window and a weekly one, the same shape the plan enforces.
- the queue stops when the plan says a window has no room left, and carries
  on when the window rolls over. Nothing needs an operator.
- the token budget in the settings is only the **fallback** for a plan that
  cannot be reached. As soon as the server answers again, the plan decides.

The Token Plan publishes its windows as whole percentages, with no absolute
allowance, so the queue reads the percentage and not a count. The margin it
keeps is two points: the plan publishes whole percentages, and two points
are enough to finish the analysis that is already running without starting
one that could not be paid for.

While somebody else is in the same plan, the queue leaves them their share
and takes only its own. The plan's percentage is what shows that somebody
else is in there: the pool moves while nothing of ours is being sent.

This is why the numbers in this document are the ones to watch. The plan is
the budget: what it says is left is what there is.

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

**How long does the database take? (p95, per operation):**

```text
histogram_quantile(0.95, sum by (le, operation) (rate(foldergram_db_query_duration_milliseconds_bucket[5m])))
```

**Which table is the slow one? (average per query):**

```text
sum by (table) (rate(foldergram_db_query_duration_milliseconds_sum[10m]))
/
sum by (table) (rate(foldergram_db_query_duration_milliseconds_count[10m]))
```

**The queries that fail:**

```text
sum by (operation, table) (rate(foldergram_db_query_count_total{status="error"}[10m]))
```

**How long does the API take? (p95, per route):**

```text
histogram_quantile(0.95, sum by (le, route) (rate(foldergram_http_request_duration_milliseconds_bucket[5m])))
```

**How many requests fail?**

```text
sum by (route, status_class) (rate(foldergram_http_request_count_total{status_class=~"4xx|5xx"}[10m]))
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
   - *Database latency*: the `histogram_quantile` by operation, and the
     average per table
   - *API latency*: the `histogram_quantile` by route
3. **Units**: set the unit of the token panels to `short` and the latency
   panels to `milliseconds`, so Grafana formats them.

### The ready-made dashboard

There is one, in [`deploy/grafana/foldergram-ai.json`](../../deploy/grafana/foldergram-ai.json).
It has a row for the plan - what is left of each window, how long it lasts
at the current rate, and whether somebody else is in the pool - and the
rows for the queue, the analyses, the cost, the stages and the errors.

To deploy it, copy it into the folder Grafana provisions from:

```bash
scp deploy/grafana/foldergram-ai.json \
  obs01:/var/lib/grafana/dashboards/foldergram/ai.json
```

Grafana picks it up in half a minute. The data source it uses is the one
already provisioned on that host (Mimir), and the dashboard depends on
nothing else.

The two scripts next to it add panels to an existing dashboard, and both
are idempotent:

```bash
python3 deploy/grafana/add_plan_panels.py     # the row of the plan
python3 deploy/grafana/add_cost_panels.py     # the cost of one analysis
```

### Reading the plan's row

- The plan is the limit, not the token budget in the settings. What the
  provider publishes is what the queue obeys.
- *Lasts* is what is left divided by how fast it is going: the answer to
  "when does this run out".
- *Shared* means somebody else is in the plan. The queue takes only its
  share while that is so, and the panel says how long it has been the
  case.

## Profiling

The metrics say **how long**. The flame graph says **where**. The
application can push continuous profiles of the Node.js process to a
Pyroscope server, and Grafana reads them as a flame graph.

```
┌────────────────────┐    pprof      ┌─────────────┐
│    Foldergram      │ ────────────▶ │  Pyroscope  │ ──▶ Grafana (flame graph)
│  (Node.js process) │               │  (obs01)    │
└────────────────────┘               └─────────────┘
```

The profiles go straight to Pyroscope: the application pushes them with the
official Node.js client, so there is no Collector in between. The Collector
is only needed for the metrics and the traces.

### Turning it on

Profiling is **off** unless `PYROSCOPE_SERVER_ADDRESS` says where the
profiles go. When it is off the profiler is not even loaded, so there is no
cost at all.

```bash
# /etc/systemd/system/foldergram.service.d/profiling.conf
[Service]
Environment=PYROSCOPE_SERVER_ADDRESS=http://10.0.2.254:4040
Environment=PYROSCOPE_APPLICATION_NAME=foldergram
```

```bash
systemctl daemon-reload
systemctl restart foldergram
journalctl -u foldergram -n 20 --no-pager | grep -i profiling
```

```
[server] Profiling enabled | server=http://10.0.2.254:4040 | app=foldergram | heap=off
```

The profiles carry the same resource attributes as the metrics (`env`,
`host`), so a profile and a metric of the same deployment are labelled the
same way.

### What the profile types mean

| Profile type | What it is |
| --- | --- |
| `wall` | The wall clock: the time the process spent, including the time it spent **waiting**. |
| `cpu` | The CPU time: the time the process spent computing. |
| `memory` | The allocations. Only with `PYROSCOPE_HEAP_PROFILING=1`. |

The `wall` profile is the interesting one for the database: the time spent
waiting for PostgreSQL is charged to the stack that was waiting for it, so
the flame graph shows the round trip to the database as the width of the
frames of `pg` and of the socket, not as a hole.

### Reading the flame graph

The frames of the Node.js process carry the file and the line, so the graph
points at the code:

```
node:net:afterConnect:1590
node:events:onceWrapper:628
pg/lib/connection.js:(anonymous:L#47:C#42):47     <- waiting for the answer
```

In Grafana, the Pyroscope app reads the data source called `Pyroscope` and
draws the flame graph of the application `foldergram`. The profile type to
choose is `wall` for the time and `cpu` for the computation.

### Checking that it works

```bash
# The application is pushing
journalctl -u foldergram --since '-10 min' --no-pager | grep -i profiling

# The profiles arrived (the client only logs a failure when it cannot push)
# In Grafana: Explore -> Pyroscope -> application "foldergram"
```

## The traces in Tempo

The Collector can also hand the traces to a Tempo, which is where they become
a tree of spans that can be read one request at a time.

```yaml
# /opt/otelcol/config.yaml
exporters:
  otlp/tempo:
    endpoint: 10.0.2.254:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp/tempo, debug]
```

After the change, the Collector has to be restarted:

```bash
systemctl restart otelcol
```

In Grafana, the `Tempo` data source reads them. A trace of a request that
was slow looks like this:

```
http.request  http.route=/api/feed  http.duration_ms=783
├── db.query   db.operation=SELECT  db.sql.table=images  db.duration_ms=507
└── db.query   db.operation=SELECT  db.sql.table=images  db.duration_ms=267
```

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
systemctl show foldergram -p Environment --value | tr ' ' '\n' | grep -E 'TELEMETRY|OTEL|PYROSCOPE'

# 2. the Collector is alive
curl -s http://127.0.0.1:13133/

# 3. the data reaches the Collector
curl -s http://127.0.0.1:8889/metrics | grep -E '^foldergram_(ai|db|http)'

# 4. the traces reach the Collector
journalctl -u otelcol --since '-5 minutes' --no-pager | grep -i 'Traces'
```

On the application's side, the journal must stay quiet. The exporter logs a
failure if it cannot push:

```bash
journalctl -u foldergram --since '-1 hour' --no-pager | grep -i 'telemetry'
```

**No profile in Pyroscope.** Check that the service has
`PYROSCOPE_SERVER_ADDRESS`, that the application is reachable from the
Pyroscope (`curl -s http://<pyroscope>:4040/ready`), and that the profiles
are not being rejected: the Pyroscope journal says `profile rejected` when it
drops one. The client only logs a failure when it cannot push, and only with
`DEBUG=pyroscope`.

**The flame graph is empty.** The profiles arrive with the time of the
profile, so a query over a range that does not include them finds nothing.
The Pyroscope API takes the range in **milliseconds**, not in seconds: a
query in seconds looks at January 1970 and quietly returns nothing.

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
| `server/src/observability/db-telemetry.ts` | The database metrics and the `db.query` spans (`recordDbQuery`, `describeQuery`). |
| `server/src/observability/http-telemetry.ts` | The request metrics and the `http.request` spans (`recordHttpRequest`, `startHttpRequestSpan`, `resolveRoute`). |
| `server/src/observability/pyroscope.ts` | The profiler (`startProfiling`, `stopProfiling`). |
| `server/src/observability/instruments.ts` | The instruments, rebuilt when the meter provider changes. |
| `server/src/db/driver/postgres-driver.ts` | Measures every query, the failed ones included. |
| `server/src/db/driver/sqlite-driver.ts` | The same, for SQLite. |
| `server/src/index.ts` | Starts the pipeline at boot, flushes it on shutdown. |
| `plugins/ai-analysis/src/storage.ts` | Emits the usage of every analysis. |
| `plugins/ai-analysis/src/analyzer.ts` | Opens the trace and the stage spans. |
| `plugins/ai-analysis/src/worker.ts` | Emits the queue depth and the pauses. |
| `server/test/telemetry.test.ts` | The tests of the AI metrics and traces. |
| `server/test/db-telemetry.test.ts` | The tests of the database metrics and spans. |
| `server/test/http-telemetry.test.ts` | The tests of the request metrics and spans. |
