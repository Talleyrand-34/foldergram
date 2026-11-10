# Upstream Sync Proposal — adopting foldergram v1.3.0 / v1.3.1

> Fork: `Talleyrand-34/foldergram` · Upstream: `foldergram/foldergram`
> Fork point: **v1.2.2** (`6e4ff07`, released 2026-06-01)

---

## 0. Decisions taken (2026-11-10)

| Decision | Outcome |
|---|---|
| This fork is a **different application**, not a downstream of upstream | We do not track upstream's releases. We cherry-pick **features**, not releases. |
| **PostgreSQL first class, SQLite practically dropped** | Upstream's SQLite-only, sync `better-sqlite3` code is irrelevant to us. Every feature we take is ported to the async `IDbDriver` abstraction. `node:sqlite` is an experimental Node 22+ built-in, so it also ties the whole project to Node 22. |
| **Carousel posts: deferred** | The `posts`/`post_items` refactor breaks `instagram-sync` (writes `collection_items.image_id`) and the AI caption backfill (`images.caption` → `posts.caption`). It is the single most expensive upstream feature and the least relevant to a fork whose differentiators are AI analysis and Instagram sync. |
| **Testing moves to `ct187`** | Proxmox CT 187 (`debian-test`, 10.0.36.10, 12 cores / 30 GB) runs the suites. Localhost was overloaded. See [§9](#9-test-infrastructure). |
| **Node 22 is a hard requirement** | The suite needs `node:sqlite` (Node 22.5+). On Node 20, **142 of 143** server test failures were `Error: No such built-in module: node:sqlite` — an environment fault, not a code fault. |
| **Dependency policy** | Same-major upgrades only, applied. Majors (zod 4, vite 8, vitest 5, vue-router 5, pinia 4, chokidar 6, typescript 7, …) deferred and documented, because each carries real breakage risk and would collide with the migration work. |

### What was implemented

- ✅ **Direct-MP4 playback policy** (upstream `video-playback-policy.ts` + `derivative-cache.ts`, ported): a video streams from the original file when it is an MP4 with `playback_strategy = 'original'`, ≤ 24 MiB and ≤ 1500 px wide; everything else gets a generated preview instead of shipping the raw file. Empty (0-byte) derivative cache files are now treated as missing and regenerated.
- ✅ **German locale** (`de`): 1111 keys, identical structure to `en`; 712 reused from upstream's v1.3.x German file, 398 hand-written for the fork's AI/Instagram namespaces. Server-side `defaultLocale` accepts `de`.
- ✅ **Dependency updates** + `node:22.23.4` in the Dockerfile (fixes **CVE-2026-111497**, Brotli RCE).
- ✅ **Clean-install build fix** (real latent bug): `pnpm build` failed on any machine without a stale root `node_modules/@types/`, i.e. **every Docker image build**. Fixed by declaring `@types/express-serve-static-core` in the server package and by re-exporting the express types from the server's plugin contract so the plugins — which are *not* pnpm workspace packages — stop depending on the host's `node_modules`.
- ✅ **Postgres-first test harness** (`server/test/helpers/`, `server/vitest.config.ts`, `server/test/setup.ts`, `server/test/dialect-parity.test.ts`, `server/test/migration-safety.test.ts`) with a live PostgreSQL on `ct187`.

### Test status (ct187)

| Suite | Result |
|---|---|
| Server / SQLite | **438 / 438** — stable across repeated runs |
| Server / PostgreSQL (live) | **438 / 438** — three consecutive runs, same assertions |
| Client | **157 / 157** (35 files) |
| Builds | server + both plugins + client, on a clean install ✅ |
| End-to-end | the server boots on PostgreSQL, migrates, loads the plugins, scans and serves `/api/status` + `/api/folders` ✅ |

The PostgreSQL path ends with **0 app tables in `public`**: every test file works in its own schema
and the shared schema stays untouched. The harness fails the run loudly if that ever changes.

### Real bugs found and fixed along the way

| Bug | Impact |
|---|---|
| `pnpm build` failed on a clean install (TS2742) | **every Docker image build was broken** |
| Plugins resolved `express` types through a stale root `node_modules` | plugin build broken on any clean machine |
| **`dbmate` ignores the libpq `options` parameter** | the migrations always landed in `public`, so every test file silently shared the same tables. The runner now translates the connection string into dbmate's native `?search_path=` |
| The translation had to keep the **whole** search path list | dropping `public` from it made `gin_trgm_ops` unresolvable, and the trigram indexes of the AI migration failed |
| `pg_stat_activity` has **no `search_path` column** | the cleanup query threw, the scratch schema was never created, and the migrations ran against the shared database |
| The setup restored the base `DATABASE_URL` after every file | a file could migrate the shared `public` schema instead of its own |
| `pg` returns `BIGINT` as a string | `taken_at` / `sort_timestamp` / `file_size` were strings on Postgres, numbers on SQLite |
| `folders.image_count` replaced the visible-media filter | excluded and emptied folders stayed in the library |
| `folders.avatar_image_id` has no `ON DELETE` and the delete path did not clear it | **permanently deleting a folder avatar failed on PostgreSQL** (SQLite ignores foreign keys by default, so it only ever showed up on Postgres) |
| `KnownProgress.reached` was never initialised | `NaN` → the Instagram catch-up detection never fired |
| Lazy-derivative dedup window closed before the file check | a concurrent request could trigger a second generation |
| `app_settings` leaked between tests | a stale `scanner.library_rebuild_required` made the route answer `409` |
| `pg_trgm` was never created | a fresh Postgres could not run migration `0011_ai_analysis.sql` |
| `CREATE EXTENSION` inside a migration | it takes a catalog lock; 73 files migrating in parallel serialised into 70 s waits. The runner creates the extension instead, and only when it is missing |
| The PostgreSQL pool defaulted to 10 connections per pool | 73 parallel files exhausted the connection limit ("sorry, too many clients already"). Small pools in tests |
| The scan run was marked "completed" **before** the cached stats were refreshed | a reader that waits for the finished run could still read the counts of the previous scan |
| 14 stale compiled `.js` files in `server/src/**` | vitest resolved `./x.js` to the stale artifact, so source edits were silently ignored |




---

## 1. Where we stand

| | Fork | Upstream |
|---|---|---|
| Base | v1.2.2 | v1.2.2 |
| Commits since base | 69 (`feat/laya-canonicalizer`) + uncommitted work | 46 |
| Released versions since base | none (fork-only) | **v1.3.0** (2026-10-31), **v1.3.1** (2026-11-03) |
| Unreleased on `main` | — | 3 commits: folder **Likes tab**, likes-nav fix, docs CI |
| Runtime DB | SQLite **and** PostgreSQL (driver abstraction) | SQLite only (`better-sqlite3`, sync API) |
| Plugin system | yes (`server/src/plugins/`, 2 plugins) | no |

**Unreleased upstream work we can take for free** (not in any release):
- `1af5385` feat: add Likes tab to folder page
- `8d084f7` fix: keep folder Likes navigation and tab state consistent

---

## 2. Upstream feature-by-feature assessment

Legend: **Value** (benefit to this fork) · **Cost** to adopt in *our* tree · **Risk**

### v1.3.0

| Feature | Value | Cost | Risk | Verdict |
|---|---|---|---|---|
| **Carousel posts** (folder-based, 2–20 slides, one post = one caption/likes/collection) | High | **L** | **High** — it is the `posts`/`post_items` refactor | Defer or adopt with shim (§5.1) |
| **Folder sharing** (read-only links, expiry, revoke, per-folder passwords) | High | M | Med — new tables + 28 new API lines, must be Postgres-ported | **Adopt** |
| **`.nofoldergram` exclusion markers** | Med-High | S | Low — new util + scanner hook | **Adopt** |
| **Node 22.23.4** (fixes CVE-2026-111497, Brotli RCE) | **High** | XS | None | **Adopt immediately** |
| **Transactional permanent deletion** (quarantine → one DB txn, rollback, startup recovery) | High | M | Med | **Adopt** |
| German locale + translation coverage | Med | S | Low — we add `de`, keep `en/es/zh` | **Adopt** |
| Video preview fixes (audio-track selection, empty-cache recovery, temp-file validation) | Med | S | Low | Adopt (mostly benefits thumbnails; we disabled video previews) |
| Migration-safety / Windows cleanup | Low | XS | None | Adopt opportunistically |

### v1.3.1

| Feature | Value | Cost | Risk | Verdict |
|---|---|---|---|---|
| **SQLite WAL + shutdown checkpoint + 5s lock retry** | High | S | Low (SQLite-only, no impact on PG) | **Adopt** |
| **Quick scan** (`POST /api/admin/rescan` + `{"repairDerivatives":false}`) | High | M | Med | **Adopt** |
| **Pagination** (`/api/folders` page/limit/search/sort/totals; reels **cursor** pagination) | High | M | Med-High — overlaps our own pagination | Adopt **cursor reels** only; keep our folders pagination |
| **Direct MP4 playback** (≤24 MiB, ≤1500px, H.264/yuv420p, AAC or none) | Med-High | M | Med | **Adopt — it replaces our blanket "no previews" rule** (§5.2) |
| **Cache revalidation for originals** (ETag/304) | Med | XS | Low | **Adopt** |
| Boot perf (skip cache-dir scans, bound bootstrap load, indexed admin stats) | High | M | Med — overlaps our `app_settings` counters | Adopt *only* the "skip cache-dir scan" part; keep our counters (faster) |
| Post viewer responsive/borderless layout, portrait-video sizing | Med | M | Med — we also changed `PostViewer.vue` | Adopt |
| Shared video mute preference | Low-Med | XS | Low | Adopt; combine with our playback-speed control |
| `pnpm test:browser` | Med | S | None | **Adopt** |
| Folder Likes tab (unreleased) | Low-Med | S | Low | Adopt (free) |

### What we already built ourselves (upstream overlap)

| Fork feature | Upstream equivalent | Our version is… |
|---|---|---|
| Folders/likes pagination + infinite scroll (`eaa197d`, `3407795`) | v1.3.1 folder pagination | **Ours lacks** folder-name/parent/path full-text search and totals-from-server |
| Reels candidate cap (`eaa197d`) | v1.3.1 reels cursor pagination + 512-candidate queue | Upstream's is **better** (cursor + session queue) |
| `app_settings` media counters (`566fe2d`) | v1.3.1 indexed admin stats | **Ours is better** (no COUNT at all) |
| Always serve originals, skip video previews (`07d259b`) | v1.3.1 selective direct playback | Upstream's is **better** (keeps previews for big/incompatible files) |
| PostgreSQL support (`cf7e326` …) | none | Ours is **unique** — and is the main cost multiplier (§4.4) |
| Plugin host (`8201b00`) | none | Ours is **unique** |
| Fuzzy library search (`f39d5f3`), playback speed, AI analysis, Instagram sync | none | Ours is **unique** |

---

## 3. Cost of a plain merge (measured, not estimated)

- **37 textual conflicts** across 30+ files: `README.md`, `client/src/{api/gallery.ts,components/{FolderHeader,ReelPlayerCard}.vue,locales/{en,es,zh}.json,stores/folders.ts,types/api.ts,views/{LibraryView,PostView}.vue}`, `server/src/{app.ts,db/{database,migration,repositories}.ts,index.ts,routes/{api,lazy-derivatives}.ts,services/{derivative-migration-service,derivative-service,gallery-service,scanner-service}.ts,types/models.ts}` + 9 test files + 4 docs files.
- **Migration directory mismatch — silent failure.** Upstream writes `server/db/migrations/000004_add_folder_shares.sql` and `000005_add_posts_and_carousels.sql` into the **flat** directory. Our migration runner reads `server/db/migrations/sqlite/` and `server/db/migrations/postgres/`. Upstream's migrations would **never execute**, and the fork already has `postgres/000004_*`/`000005_*` → version-number collision.
- **`posts`/`post_items` breaks two of our plugins.** Upstream migration `000005` **drops and rebuilds** `likes` and `collection_items` keyed by `post_id` (the `image_id` column is deleted). Our `instagram-sync` writes `collection_items (collection_id, image_id, created_at)` → **breaks outright**.
- **AI caption backfill silently dies.** Upstream moved the user-visible caption to `posts.caption`; `images.caption` is now vestigial (2 internal selects only). Our `updateCaptionIfNull()` writes `UPDATE images SET caption = …` → AI summaries would stop appearing in the UI **with no error**.
- **Plugins are pinned to `server/dist`.** Both plugins import `../../../server/dist/db/repositories.js` etc. A merge that changes server module *shapes* breaks the compiled plugin JS **silently at runtime** — and `dist/` is committed, so stale plugin JS survives a merge.

---

## 4. Blockers ranked

### 4.1 `posts` / `post_items` identity refactor — **critical**
Upstream re-keys likes + collection membership to `post_id`. For single posts upstream backfills `posts.id = images.id`, so ids coincide — **except for carousels**, where one post has N slides. Our `video.indexed` hook carries `images.id`, not a post id, and our `ai_*` columns live on the **slide** row, not the post row.

### 4.2 Dual-driver porting — **the hidden multiplier**
Upstream's new code is written against the **sync `better-sqlite3` API**. Our repositories were fully converted to an **async `IDbDriver`** abstraction (`0` occurrences of `database.prepare` left in our tree; upstream's diff adds **95**). Upstream's new SQL is only lightly SQLite-specific (5 `INSERT OR IGNORE`, 1 `PRAGMA`, 2 `json_each`, 4 `strftime`) — those are cheap to fix — but **every** new query call site must be rewritten `database.prepare(...).all()` → `await driver.query(...)`, and the Postgres driver must learn the new shapes (e.g. `post_items`, `folder_share_links`).

### 4.3 Migration runner unification — **must fix before any merge**
Options:
- **(a)** Move our dialect dirs under a versioned namespace and add upstream's `000004`/`000005` as `sqlite/` + `postgres/` variants. Cleanest, but requires hand-porting upstream's `000005` (SQLite-specific `AUTOINCREMENT`, temp tables, `CREATE TABLE … AS`) to Postgres.
- **(b)** Keep upstream's flat dir as the source of truth and make our runner dialect-aware (read `migrations/<dialect>/` if present, else flat).

### 4.4 Plugin host hardening — **independent of the merge**
- `host.ts` `requireAuth` is a **no-op**: both branches of the ternary are identical, and plugin routes are mounted on `app`, *after* `app.use('/api', …, requireApiAuthentication, apiRouter)` — so plugin routes **bypass** API auth. Our plugins re-implement guards internally, but a `requireAuth:false` plugin would be wide open.
- `HookEvents` has exactly one event (`video.indexed`). No delete/trash/scan-complete/collection hooks → **AI rows for deleted media are never cleaned up**, and folder rollups can dangle (no FK on `ai_folder_rollup.folder_id`).

### 4.5 Interaction risks
- `AI_ANALYSIS_AUTO_QUEUE=1` + upstream **quick scans** → hook storm (quick scans re-walk the gallery).
- Upstream's `.nofoldergram` is a *second* exclusion mechanism; our dot-prefix skip (`isHiddenPath`) still protects `.instagram-sync/` in both trees — verified upstream still skips dot segments.
- Upstream added `routeTimingMiddleware`; we already have `metrics-service.ts` + `/api/metrics` + `/api/db/time`. **Don't import theirs.**

---

## 5. Proposal

**Strategy: staged rebase onto upstream, keeping our three differentiators (PostgreSQL, plugin host, AI/Instagram plugins).** Do not merge `origin/main` wholesale — the `posts` refactor and the sync→async API break make a blind merge more expensive than a curated port.

### Phase 0 — Immediate, zero-conflict wins (this week)

| PR | Content | Source |
|---|---|---|
| `chore/security`: Node 22.23.4 in Dockerfile + CI | fixes CVE-2026-111497 | upstream `b1dbdc3` |
| `chore(deps)`: adopt `pnpm test:browser` harness | viewer/navigation/folder-browsing browser tests | upstream v1.3.1 |
| `feat(cache)`: ETag/304 revalidation for original media | pairs with our originals-first playback | upstream `a6ccdf6` |
| `fix(derivatives)`: empty cache-file detection + temp-file preview validation | thumbnails still cached; previews may return | upstream `e82bf8c`, `9926565` |

### Phase 1 — Perf layer from v1.3.1 (biggest bang, low breakage)

| PR | Content | Fork-specific work |
|---|---|---|
| `perf(db)`: SQLite WAL + shutdown checkpoint + 5s lock retry | `984ba72`, `7939e6e` | none (SQLite-only); verify Postgres path unaffected |
| `perf(scan)`: quick scan (`repairDerivatives:false`) + selective preview reclaim | `bfca82c` | reconcile with our "skip previews" rule (§5.2) |
| `perf(reels)`: cursor pagination + 512-candidate session queue | `6d78963` | replace our `eaa197d` cap; update `types/api.ts` |
| `perf(folders)`: server-side folder search over name/parent/path + totals | `8bc78fa` | **extend our existing pagination**, don't replace it |
| `feat(viewer)`: responsive post viewer, portrait-video sizing, offscreen pause | `2684d4f`, `d8e250e` | re-apply our AI sidebar + speed button |
| `feat(player)`: shared mute preference | `ea1c298` | merge with our ×1/×2/×3 speed control into one player prefs store |

**Explicitly skip**: upstream's `routeTimingMiddleware` (we have `metrics-service`), upstream's "indexed admin stats" (our `app_settings` counters avoid COUNT entirely).

### Phase 2 — v1.3.0 features

| PR | Content | Fork-specific work |
|---|---|---|
| `feat(i18n)`: German locale + upstream translation coverage | `fcd5501`, `3961951` | add `de`; keep our `en/es/zh` + `ai`/`instagramSync` namespaces |
| `feat(exclusions)`: `.nofoldergram` markers | `174cc16` | verify dot-skip still protects `.instagram-sync/`; add PG-port of marker checks |
| `feat(sharing)`: folder share links + passwords | `5861237` | **port 551-line service to async driver**; PG migration `000004` variant; keep plugin auth model intact |
| `fix(delete)`: transactional permanent deletion + quarantine + recovery | `0aa82e4`, `71564e9` | port 908-line service to async driver; PG variant |

### Phase 3 — The two hard decisions (need your call)

#### 5.1 Carousel posts
**Recommendation: DEFER.** Cost is disproportionate for us:
- It *is* the `posts`/`post_items` refactor, which breaks `instagram-sync` and the AI caption path.
- Our AI metadata is per-**slide**; carousel UX wants per-**post**. Needs a real data-model decision (post-level rollup table), not a port.
- 186-line migration + carousel reconciliation + a whole new viewer.

**If you want it anyway**, the minimum safe path:
1. Add `post_id` resolution helper: `postIdForImage(imageId)` (upstream guarantees `posts.id = images.id` for singles).
2. Change `instagram-sync` to resolve image→post before `collectionRepository.addImage(slug, postId)`.
3. Change AI caption backfill to **dual-write** `posts.caption` + `images.caption`.
4. Extend the hook contract to `post.indexed { postId, imageIds[] }`.
5. Port the migration to Postgres (`AUTOINCREMENT` → `BIGSERIAL`, temp tables → CTE, `CREATE TABLE … AS` → `INSERT … SELECT`).

#### 5.2 Video playback policy
We currently **never** generate video previews and always serve originals (`07d259b`). Upstream generates previews only for files that can't play directly (>24 MiB, >1500px, non-H.264/yuv420p, exotic audio).

**Recommendation: adopt upstream's policy.** Our blanket rule means a 2 GB ProRes file is streamed raw to every remote viewer — upstream transcodes it once and serves a small preview with an HD toggle. This is a strict improvement for large libraries and it also restores `scan and repair derivatives` as a meaningful action.

Implementation: port `video-playback-policy.ts` + `derivative-cache.ts`, and **delete** the blanket skip rather than layering both.

### Phase 4 — Fork-specific adaptations (do these regardless of upstream work)

| PR | Content |
|---|---|
| `feat(plugin-host)`: real `requireAuth` enforcement — mount plugin routes **inside** the authenticated `/api` chain, or apply `requireApiAuthentication` explicitly in `mountRoutes` | fixes the no-op ternary in `host.ts` |
| `feat(plugin-host)`: stable public API surface — export a `pluginApi` object from the server package so plugins stop importing `server/dist/**` (which breaks silently on merge) | removes the merge-time landmine |
| `feat(plugin-host)`: extend `HookEvents` → `post.indexed`, `post.deleted`, `scan.completed`, `collection.changed` | lets AI-analysis clean up deleted media and lets `instagram-sync` react to scans |
| `fix(ai-analysis)`: Postgres-dialect leakage — `media_type::text` casts and `is_deleted = 0` in `plugins/ai-analysis/src/storage.ts` (lines ~726, 787, 813, 853, 855, 866, 927, 944, 984) are invalid on SQLite; the file is internally inconsistent | fix now, independent of upstream |
| `fix(ai-analysis)`: `NULLS LAST` hack at `storage.ts:1124` — replace with a portable expression | fix now |
| `fix(ai-analysis)`: FK `ai_folder_rollup.folder_id → folders.id` (currently none) + orphan cleanup | fix now |
| `chore(db)`: unify migration layout — one source of truth, dialect-aware runner, no version collisions | **prerequisite for any upstream merge** |

### Phase 5 — Post-merge polish
- Folder **Likes tab** (upstream `1af5385` + `8d084f7`) — free.
- Our own additions on top of the merged base:
  - **AI summaries over carousels** (post-level rollup over slide-level analysis).
  - **Instagram sync → post-aware** collections (post id instead of image id).
  - **`/api/db` + `/api/metrics`** stay fork-only; make them Postgres-aware for WAL/PRAGMA reporting.
  - **Shared-link awareness for the AI plugin**: shared visitors must never see AI transcripts (they can contain speech content). Currently `getImageDetail` returns the `ai` block — check upstream's share-response redaction applies to it.

---

## 6. Decision points (need your input)

1. **PostgreSQL — keep or drop?** This is the single biggest cost multiplier. Every upstream feature must be hand-ported to the async dual-driver layer. If we dropped Postgres, merging upstream becomes a ~1-week job instead of a multi-week one. **Recommendation: keep it** — it's a real differentiator — but budget the porting explicitly.
2. **Carousel posts — in scope now?** Recommendation: defer (§5.1).
3. **Video policy — adopt upstream's hybrid?** Recommendation: yes (§5.2).
4. **Should the fork keep shipping its own releases?** If yes, we should cut a fork release (e.g. `v1.3.1-fork.1`) documenting exactly which upstream features are included — makes future merges much cheaper.

---

## 7. Estimated effort

| Phase | Scope | Effort | Breaking risk |
|---|---|---|---|
| 0 | CVE fix, browser tests, cache headers, cache validation | **S** (0.5–1d) | none |
| 1 | WAL, quick scan, reels cursor, folder search, viewer polish, mute pref | **M** (3–5d) | low |
| 2 | German, `.nofoldergram`, folder sharing, transactional deletion | **L** (6–10d) | med (sharing touches auth) |
| 3a | Carousel posts (with shims) | **XL** (10–20d) | **high** |
| 3b | Video policy switch | **S** (1d) | low |
| 4 | Plugin host hardening + hook contract + AI dialect fixes + migration unification | **M** (4–6d) | low (fork-only) |
| 5 | Folder Likes tab + fork-specific extras | **S–M** (2–4d) | low |

**Order matters:** Phase 4's migration unification is a **prerequisite** for Phase 1/2 (any upstream SQL migration must land in our dialect dirs). Plugin-host hardening should land **before** the merge so a bad merge can't silently break the plugins.

---

## 8. Appendices — evidence

```
fork point:        6e4ff07  "chore: bump version to 1.2.2 in package.json"  (v1.2.2, 2026-06-01)
upstream releases: v1.3.0 2026-10-31, v1.3.1 2026-11-03
unreleased main:   1af5385, 8d084f7, bff3362
merge conflicts:   37 (git merge-tree --write-tree HEAD origin/main)
upstream churn:    repositories.ts +2549/-826, gallery-service.ts +812/-252,
                   scanner-service.ts +764/-41, routes/api.ts +513/-38,
                   migration.ts +480/-5, database.ts +127/-15
fork churn:        repositories.ts +1487/-1271, gallery-service.ts +589/-469,
                   routes/api.ts +596/-102, scanner-service.ts +156/-112
sync-API debt:     upstream diff adds 95 `database.prepare(...)` call sites
                   (better-sqlite3 sync) vs our 0 remaining
SQLite idioms:     upstream diff adds 5 `INSERT OR IGNORE`, 1 `PRAGMA`,
                   2 `json_each`, 4 `strftime`, 1 `datetime(`  → cheap to fix
upstream new files: sqlite-connection.ts, folder-share-service.ts (551),
                   permanent-deletion-service.ts (908), maintenance-operation-lock.ts,
                   carousels-utils.ts, derivative-cache.ts, exclusion-marker.ts,
                   video-playback-policy.ts, perf-timing.ts, route-timing.ts
```

### Reference: upstream commits available for cherry-pick

```
v1.3.0:  2dd9f20 feat(carousels)          5861237 feat(sharing)
         174cc16 feat(.nofoldergram)      0aa82e4 fix(transactional delete)
         71564e9 fix(recovery)            6a33694 fix(carousel history)
         e82bf8c fix(video audio)         9926565 fix(empty preview cache)
         fcd5501 German                   3961951 localizations
         b1dbdc3 Node 22.23.4             ba0a453 chore(v1.3.0)
v1.3.1:  c0da88f perf(bootstrap)          bfca82c perf(quick scan)
         984ba72 perf(WAL)                7939e6e fix(sqlite locks)
         6d78963 perf(reels cursor)        8bc78fa perf(folder pagination)
         a6ccdf6 perf(cache revalidate)   ea1c298 fix(shared mute)
         2684d4f fix(responsive viewer)    d8e250e fix(offscreen pause)
         31ebdcc chore(v1.3.1)
main:    1af5385 feat(folder Likes tab)   8d084f7 fix(likes nav)
```

---

## 9. Test infrastructure

Local runs were overload-prone, so the suites run on **ct187**.

| | |
|---|---|
| Host | Proxmox CT 187, hostname `debian-test`, `10.0.36.10` |
| Access | `ssh -i ~/.ssh/localinfra root@10.0.36.10` |
| Specs | 12 cores, 30 GB RAM, 59 GB free |
| Node | v22.23.4 (`/usr/local/bin/node`), corepack pnpm 10.28.0 |
| Postgres | 17, local, port 5432, `pg_trgm` installed |
| Database | `postgresql://foldergram:foldergram@localhost:5432/foldergram?sslmode=disable` |
| Checkout | `/root/foldergram-test` |

### Sync and run

The local checkout stays the single source of truth. Edit locally, sync, then run:

```bash
rsync -az --delete \
  --exclude 'node_modules/' --exclude 'dist/' --exclude '.claude/' \
  --exclude 'graphify-out/' --exclude 'data/' --exclude '*.log' \
  -e "ssh -i ~/.ssh/localinfra" ./ root@10.0.36.10:/root/foldergram-test/

ssh -i ~/.ssh/localinfra root@10.0.36.10
cd /root/foldergram-test
corepack pnpm --filter @foldergram/server test
corepack pnpm --filter @foldergram/client test
```

Run the server suite against the live PostgreSQL instead of SQLite:

```bash
DB_DRIVER=postgres \
DATABASE_URL=postgresql://foldergram:foldergram@localhost:5432/foldergram?sslmode=disable \
  corepack pnpm --filter @foldergram/server test
```

> The server suite needs `server/dist/` and `plugins/*/dist/` to be built before the plugin tests
> can import from them: `corepack pnpm --filter @foldergram/server build`.

### Node 22 requirement

`server/src/db/driver/sqlite-driver.ts` imports `node:sqlite`, which exists only from Node 22.5.
On Node 20 every database-backed test failed with `Error: No such built-in module: node:sqlite` —
142 of the 143 server failures at the time of writing. `fnm` is configured in `~/.zshenv` so every
shell (including non-interactive ones) defaults to Node 22.
