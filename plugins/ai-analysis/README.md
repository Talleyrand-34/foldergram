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
extract 3 frames + 16 kHz mono audio
        │
        ▼
POST /v1/chat/completions (vision: frames + transcript → JSON)
POST /v1/audio/transcriptions (whisper: audio → transcript)
        │
        ▼
store {summary, domains[], tags[], transcript, ...} on the images row
```

All AI calls go to `http://10.0.2.31:4000/v1` (the LiteLLM proxy on
minisforum). Vision routes to `minimax/MiniMax-M3`; audio routes through our
local `whisper-server` at `:11114` (registered as `whisper-1` in LiteLLM).

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

| URL | purpose |
|---|---|
| `http://10.0.2.31:4000/v1/chat/completions` | vision LLM (`minimax/MiniMax-M3`) |
| `http://10.0.2.31:4000/v1/audio/transcriptions` | whisper (routed by LiteLLM to local `:11114`) |
| `http://10.0.2.31:4000/v1/embeddings` | available but unused (SQL search is enough; see `runs/p4-storage-report.json`) |

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
