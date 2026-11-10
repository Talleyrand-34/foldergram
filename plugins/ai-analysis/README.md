# ai-analysis plugin

AI-powered analysis for videos in Foldergram. Listens for new videos, runs
vision + audio through the AI gateway on minisforum, and stores
`{summary, domains, tags, transcript, language, sentiment}` per video.

## How it works

```
scanner-service indexes a video
        │
        ▼
plugin host fires "video.indexed"
        │
        ▼
this plugin marks the row pending
        │
        ▼
background worker picks it up (one at a time)
        │
        ▼
extract frames + 16 kHz mono audio
        │
        ▼
POST /v1/chat/completions (vision: frames + transcript → JSON)
POST /v1/audio/transcriptions (whisper: audio → transcript)
        │
        ▼
canonicalize the domains (laya) — optional
        │
        ▼
store {summary, domains[], tags[], transcript, ...} on the images row
```

## Providers and pipeline configuration

The schedule of the pipeline — which endpoint it talks to, which model each
stage uses, and what each stage does — is **configuration, not code**. It is
stored in `app_settings` under `ai_analysis.config` and edited from the
**AI settings → Providers and pipeline** page. No restart, no environment
edit.

### Providers

A provider is an endpoint plus credentials plus a default model:

| field | meaning |
|---|---|
| `id` | stable slug, unique within the configuration |
| `label` | display name |
| `dialect` | `openai-compatible` or `minimax` |
| `baseUrl` | the endpoint, including the version prefix (`http://10.0.2.31:4000/v1`) |
| `apiKey` | sent as `Authorization: Bearer`. Empty means no header — local gateways need none |
| `defaultModel` | the model a stage inherits when it does not name one |
| `headers` | extra headers some gateways require |
| `reasoningEffort` | MiniMax only: `low`…`max`. Empty means the API default (`max`) |
| `thinkingType` | MiniMax only: `adaptive` or `disabled`. Empty means the API default |
| `usageLimits` | this provider's own token budget and its windows — see [Usage limits](#usage-limits) |

Two dialects are supported:

| dialect | covers |
|---|---|
| `openai-compatible` | LiteLLM, Ollama, vLLM, OpenAI, Groq, Together, OpenRouter |
| `minimax` | MiniMax's own API, `https://api.minimax.io/v1` |

The two differ in three ways, and the client handles them:

- MiniMax wants **`max_completion_tokens`**; `max_tokens` is deprecated there.
- MiniMax does not document `response_format`, so it is not sent — the prompt
  already demands strict JSON and the parser copes with prose.
- MiniMax understands the **thinking controls** (`reasoning_effort`,
  `thinking.type`), and the thinking content comes back in `reasoning_content`.

The foldergram server reaches `api.minimax.io` **directly**, so a MiniMax
provider needs no gateway at all — the *Add a MiniMax provider* button fills
in the endpoint and the model; only the API key is missing.

The API key **never leaves the server**. The read path replaces it with a
`hasApiKey` flag and a short mask; the write path treats an absent `apiKey` as
"keep the stored one" and an explicit empty string as "clear it".

### Stages

| stage | configurable |
|---|---|
| vision | provider, model, max tokens, timeout, JSON mode |
| audio | provider, model, forced language, timeout |
| embeddings | provider, model, enabled, timeout |
| canonicalizer | enabled, service URL, timeout |

### The pipeline itself

| knob | default | meaning |
|---|---|---|
| `frameCount` | `3` | frames sampled per video |
| `framePositions` | `[0.1, 0.5, 0.95]` | where they are sampled, as a fraction of the duration |
| `extractAudio` | `true` | extract and transcribe the audio |
| `writeCaption` | `true` | write the summary into the post's caption when it is empty |
| `updateKnowledgeGraph` | `true` | update the domain graph and the folder rollup |
| `minDurationSeconds` / `maxDurationSeconds` | `0` | skip videos outside the range (`0` disables the check) |

The defaults reproduce the original behaviour exactly, so a deployment with no
stored configuration behaves as it did before.

### Domain canonicalization

The pipeline is four steps, in this order:

1. **laya** maps the domains the analysis proposed onto the existing
   taxonomy — a match, an alias, or a genuinely new domain. It is fast and
   cheap, but it is a *similarity* judgement: it can put a post into a domain
   that is merely the closest one it was offered.
2. **an AI check** verifies the decision. The model sees the post's content
   and judges whether the canonical domain is a genuine fit — including the
   case where laya only picked it because nothing better was on the table. A
   false positive is rejected.
3. **new domains** are registered when nothing fits, so the taxonomy grows
   instead of forcing everything into an existing bucket. A rejected match
   either moves the post to a better existing domain or registers the
   original suggestion as new.
4. **a second pass**: once the whole library has been checked and the
   taxonomy has grown, the earlier posts are re-checked against it — a domain
   that was proposed later may fit them better than the one they were given.

A post is a candidate for the second pass when a domain was created *after*
the post was analysed: that domain was not on the table when the post was
filed.

| setting | default | meaning |
|---|---|---|
| `stages.canonicalizer.enabled` | `true` | run the canonicalizer |
| `stages.canonicalizer.url` | *(empty)* | the laya service; empty disables the stage |
| `stages.canonicalizer.verify` | `true` | check laya's decision with the AI |

The second pass runs on its own when the queue drains and the taxonomy has
grown; it can also be triggered by hand:

| method | path | purpose |
|---|---|---|
| `GET` | `/api/plugins/ai-analysis/canonicalization` | the sweep's state and the domain count |
| `POST` | `/api/plugins/ai-analysis/canonicalization/run` | re-check the posts now |

#### The laya service

The canonicalizer talks to **laya-decisions** on the minisforum:

```
POST {url}/v1/route   { state, questions }  →  { model, answers, routing }
```

`/v1/route` is used rather than `/v1/decisions` because it picks the
checkpoint from the script of the content: a Spanish video goes to the
English model, a Hindi one to the multilingual model. The plugin analyses
videos in every language, so that choice matters.

The **url is the base** — the client appends `/v1/route`. The router runs on
`http://10.0.2.31:11123` and fails over to the CPU backend on its own; the
GPU and CPU services are on 11121 and 11122.

The client builds the questions the service answers:

- for each proposed domain: *"does this match an existing domain, or is it
  NEW?"* — the existing domains are the options, and `NEW` is always one of
  them, so the model can say "none of these fit";
- for the language: *"what is the canonical ISO 639-1 code?"*.

#### An unverified decision does not overrule a filed one

laya's answer is a similarity match — exactly the false positive the AI check
exists to catch. So:

- a **fresh** post may take laya's answer unchecked — it has no prior
  decision to contradict;
- the **re-check sweep** may not. If the AI check cannot run — no balance, the
  service is down — the sweep leaves the post alone rather than filing it on
  an unchecked answer. Such posts are counted as `skipped`.

### Usage limits

The token budgets that stop the queue before it runs out of credit.

The limits are **per provider**, because the providers' own allowances
differ: a paid plan counts tokens over its own window, a local model against
nothing at all. Each provider carries its own budget and its own windows.

| setting | default | meaning |
|---|---|---|
| `enabled` | `false` | enforce this provider's limits at all |
| `budget` | `0` | the provider's total token allowance |
| `windows[].hours` | — | the window's length, in hours |
| `windows[].percent` | — | the share of the budget that window may use |

The window length is **free-form**, because a provider's allowance is not: a
plan can count over a rolling 5-hour window, a calendar week, or anything
else. The limits are **percentages** of the budget, not absolute token
counts. A MiniMax plan might be configured as:

| window | share | of a 10,000,000 budget |
|---|---|---|
| 5 h | 20 % | 2,000,000 tokens |
| 168 h (a week) | 80 % | 8,000,000 tokens |

The windows are **rolling** — "in the last N hours" — because a window with
an arbitrary length has no calendar boundary to align to.

The usage is read from `ai_analysis_events`, which records the token counts of
every run *and the provider that spent them* (the `provider_id` column,
migration `0020_provider_usage.sql`). Every event counts, not only the
completed ones, because a failed run still consumed its input tokens. The
events recorded before that migration have no provider and are not attributed
to any of them.

When any window reaches its share the worker **stops claiming new videos**.
It is a *soft* pause: the videos stay `pending`, the window rolls on, and the
queue carries on. The status shows `cause: "usage_limit"` with the moment it
lifts.

A limit is checked *between* videos, so the video in flight can still take the
usage over the threshold — the limit is a brake, not a fence.

### The shared plan (the smart mode)

The hard limits answer "when do I stop spending?". The smart mode answers a
different question: **"is the plan shared right now?"**

A plan is often shared: the same MiniMax Token Plan may serve a person's
editor assistant and foldergram's bulk analysis at the same time. The plan
knows how much *everybody* used — MiniMax publishes it at
`/v1/token_plan/remains` — so the queue can tell whether it is alone in the
pool:

| the pool | what the queue does |
|---|---|
| only we are using it | take it, up to the share the operator allows — "use it until max" |
| somebody else is in it | get out of the way — stop claiming work and wait |

The two rules together are a duty cycle: full throttle when the pool is
idle, nothing at all when it is not. The waiting ends by itself, either
because the other user stopped or because the plan's window rolled over and
the usage is back at its minimum.

The mode is per provider, next to the limits:

| setting | default | meaning |
|---|---|---|
| `mode` | `hard` | `hard` uses the windows above; `smart` watches the plan |
| `smart.probeUrl` | derived | the read-only endpoint that reports the plan |
| `smart.probeApiKey` | the provider's own key | the key for that endpoint |
| `smart.watch` | `interval` | which of the plan's windows to watch |
| `smart.pollMinutes` | `2` | how often to read the plan |
| `smart.idlePercent` | `100` | the share of the plan to take while alone |
| `smart.yieldPercent` | `0` | the share of the plan to take while shared |
| `smart.contentionPercent` | `5` | the share of the plan's use above which it counts as shared |
| `smart.ignoreHardWindows` | `false` | let the plan's wall be the only limit |

**How "somebody else is in it" is measured.** The plan's counter moves by
what everybody spent; the plugin counts what it sent. What is left over is
the other user's. A plan that counts requests is compared with the requests;
a plan that counts tokens is detected and compared with the tokens.

The plan's endpoint needs a key. A provider that reaches MiniMax **directly**
already has one, and the endpoint is derived: `{baseUrl}/token_plan/remains`.
A provider that reaches MiniMax **through a gateway** needs the key written
down here, because the gateway is the one holding it.

When the endpoint cannot be read — no plan, no key, the endpoint down — the
mode **degrades to the hard limits** and the status says so. A missing plan
never stops the queue on its own.

### When the upstream runs out of credit

A provider can also run out of credit on its own — MiniMax answers
`insufficient_balance_error` — and that is not a broken configuration: the
credit is topped up and the queue carries on.

So the fault is **classified**:

| kind | what it is | what the queue does |
|---|---|---|
| `quota` | the credit or the allowance ran out | **waits**, then retries on its own |
| `unreachable` | the service could not be reached | **waits**, then retries on its own |
| `configuration` | a bad key, a missing model | **stops** until an operator resumes it |

The gateway wraps the provider's error, so the status alone is not enough: an
exhausted balance arrives as a **500** with the real reason in the body. The
body is what decides.

The wait grows with every consecutive failure — 1, 2, 5, 10, 30, 60 minutes —
so a long outage is met with one request an hour rather than one a minute,
and the ladder starts over as soon as the upstream answers. The status shows
`cause: "upstream_quota"` with the moment it retries; no operator is needed.

### The environment still seeds it

On a fresh install the configuration is seeded from the environment, so an
existing deployment keeps working unchanged:

| env | default | meaning |
|---|---|---|
| `LITELLM_BASE` | `http://10.0.2.31:4000/v1` | the seeded provider's base URL |
| `AI_API_KEY` | *(empty)* | the seeded provider's API key |
| `AI_VISION_MODEL` | `minimax/MiniMax-M3` | the seeded provider's default model |
| `AI_AUDIO_MODEL` | `whisper-1` | the audio stage's model |
| `AI_EMBED_MODEL` | `ollama/bge-m3:latest` | the embedding stage's model |
| `LAYA_CLASSIFIER_URL` | *(empty)* | the laya-decisions service, e.g. `http://10.0.2.31:11123` |
| `AI_ANALYSIS_ENABLED` | `1` | `0` disables the plugin entirely |
| `AI_ANALYSIS_AUTO_QUEUE` | `0` | `1` subscribes to the `video.indexed` hook (not recommended) |
| `AI_ANALYSIS_AUTO_BACKFILL` | `0` | `1` queues every unanalyzed video at boot |
| `AI_ANALYSIS_TMP` | `/tmp/ai-analysis` | the scratch directory |

Once the configuration is saved in the UI, the UI is the source of truth.

### API

| method | path | purpose |
|---|---|---|
| `GET` | `/api/plugins/ai-analysis/config` | the configuration (secrets masked) + its problems |
| `POST` | `/api/plugins/ai-analysis/config` | change the configuration |
| `POST` | `/api/plugins/ai-analysis/config/test` | probe a provider — even an unsaved one |
| `GET` | `/api/plugins/ai-analysis/providers/{id}/models` | the models a saved provider offers |

`POST /config/test` calls `GET {baseUrl}/models`. A `200` means the endpoint
is reachable and the key was accepted; the response lists the models it
advertises, so the UI can confirm that the chosen model exists.

`GET /providers/{id}/models` reads the same list for a **stored** provider,
with the stored key — the key never travels to the browser. The UI offers
those names as a choice, so a model cannot be mistyped. A gateway that does
not publish a list falls back to a text field.

### Changing the configuration

`POST /config` is a patch, and it is deliberately hard to destroy something
by accident:

- a provider the patch does **not** name is **kept** — a stale settings page
  cannot delete a provider somebody else added;
- a provider is deleted only when the patch names it in `removeProviders`;
- a provider's limits and smart settings survive a patch that does not
  mention them.

## Storage shape

A migration adds 12 columns to the `images` table:

| column | type | notes |
|---|---|---|
| `ai_status` | TEXT | `pending` → `running` → `ok` \| `failed` \| `skipped` |
| `ai_summary` | TEXT | one-line description |
| `ai_domains` | TEXT | JSON array of slash-notation paths (`music/reggaeton`) |
| `ai_tags` | TEXT | JSON array of lowercase tags |
| `ai_language` | TEXT | ISO 639-1 or `unknown` |
| `ai_sentiment` | TEXT | one of 6 fixed values |
| `ai_transcript` | TEXT | full whisper transcript |
| `ai_model` | TEXT | which model ran the analysis |
| `ai_usage_tokens` | INTEGER | tokens used |
| `ai_error` | TEXT | last failure reason |
| `ai_analyzed_at` | TEXT/TIMESTAMPTZ | timestamp |
| `ai_analyzed_mtime_ms` | INTEGER/BIGINT | re-analyze when source mtime changes |

Postgres has GIN indexes on generated jsonb columns for fast domain/tag
containment; SQLite uses LIKE (acceptable until the corpus is large).

## API

| method | path | purpose |
|---|---|---|
| `GET` | `/api/plugins/ai-analysis/status` | counts by status, oldest pending |
| `GET` | `/api/plugins/ai-analysis/search?q=&domain=&tag=&language=&limit=` | search analyzed videos |
| `POST` | `/api/plugins/ai-analysis/analyze/:imageId` | manual trigger (idempotent on mtime) |

## Endpoints hit on minisforum

The URLs below are the defaults; they are configuration now, not constants.

| URL | purpose |
|---|---|
| `{provider.baseUrl}/chat/completions` | the vision LLM (`minimax/MiniMax-M3` by default) |
| `{provider.baseUrl}/audio/transcriptions` | whisper (routed by LiteLLM to the local `:11114`) |
| `{provider.baseUrl}/embeddings` | available but unused (SQL search is enough; see `runs/p4-storage-report.json`) |
| `{canonicalizer.url}/v1/route` | the laya-decisions service (domain canonicalization) |

The `laya-classifier-service/` folder in this repo is the **old** wrapper
service. It spoke a single `/canonicalize` endpoint on port 4001. The service
that runs now is **laya-decisions** on the minisforum, and the plugin talks to
it directly — see [Domain canonicalization](#domain-canonicalization).

## Scratch prototypes (pre-graduation)

The four prototypes in `.scratch/` drove the design:

| prototype | what it proved | artifact |
|---|---|---|
| `p1-vision-classify.ts` | vision alone can pick domains | `runs/p1-*.json` |
| `p2-audio-transcribe.ts` | whisper works on the host's audio | `runs/p2-*.json` |
| `p3-full-pipeline.ts` | multimodal > vision alone for summary | `runs/p3-*.json` |
| `p4-storage-investigation.ts` | SQL is enough; embeddings only for "more like this" | `runs/p4-storage-report.json` |

Each prototype is runnable on its own: `bun run .scratch/pN-*.ts <video>`.

## Storage decision (from P4)

| query | strategy | latency on 100 rows |
|---|---|---|
| `domain = X` | `WHERE ai_domains LIKE '%"X"%'` (or jsonb containment on PG) | ~0.4 ms |
| `tag = X` | `WHERE ai_tags LIKE '%"X"%'` | ~0.1 ms |
| `transcript contains X` | `WHERE ai_transcript LIKE '%X%'` | ~0.5 ms |
| `domain AND tag` | AND of the above | ~0.5 ms |
| `similar to clip X` | cosine over embeddings (pgvector) | ~3.7 ms |

The first four cover every "find by word/domain" UI we want. Embeddings are
useful only for a future "more like this" feature.

## Limitations / next steps

- **Single-worker**: one video at a time, in-process. For a large library,
  add a real queue + multi-process workers.
- **No retry**: failures land in `ai_error` and stay there. Re-trigger via
  the manual `POST /analyze/:imageId` endpoint.
- **No GPU lease**: this plugin talks to LiteLLM directly. For multi-tenant
  fairness on the box, route through `gpu-broker` for vision requests
  (whisper already leases via LiteLLM).
- **No client UI**: the API endpoints work; the Vue admin page to view
  status / trigger re-analysis / browse by domain is future work.
- **No embeddings column**: SQL search is enough for now. Add
  `ai_embedding vector(1024)` later if "more like this" becomes a feature.
