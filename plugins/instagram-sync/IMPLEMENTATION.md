# instagram-sync — implementation record

What was built, in the order it was built, and how each piece was verified.
Design rationale and the verified research live in `PLAN.md` — this file is the
"what and how".

**v1 scope:** one source (`https://www.instagram.com/rodantes_6/saved/`),
gallery-dl ≥ 1.32.17 vendored and updatable from the Web UI, plugin owns
`cookies.txt` + `archive.sqlite`, downloads land **straight in the gallery**.

**Two rules that held throughout:**

1. **No new server dependency.** The plugin uses only what `server/package.json`
   already provides (`node:fs`, `node:child_process`, `node:crypto`, `node:sqlite`,
   global `fetch`) plus Python 3 + `requests` on the host.
2. **No migration in v1.** Run state lives in the existing `app_settings` store.

---

## Step 0 — Scaffolding

**Files created**

```
plugins/instagram-sync/manifest.json
plugins/instagram-sync/package.json
plugins/instagram-sync/tsconfig.json
```

`manifest.json` — `entry: "dist/index.js"`, `hooks: []`, `requireAuth: true`.

`tsconfig.json` — copied from `plugins/ai-analysis/tsconfig.json` verbatim
(`rootDir: ./src`, `outDir: ./dist`, `strict`).

**`server/package.json`** — the build now chains both plugins:

```json
"build": "tsc -p tsconfig.json && tsc -p ../plugins/ai-analysis/tsconfig.json && tsc -p ../plugins/instagram-sync/tsconfig.json",
"build:plugins": "tsc -p ../plugins/ai-analysis/tsconfig.json && tsc -p ../plugins/instagram-sync/tsconfig.json",
```

**Verify** — `npx tsc -p ../plugins/instagram-sync/tsconfig.json --noEmit` → clean.

---

## Step 1 — Config + cron (pure, testable, no I/O)

**Files**

```
plugins/instagram-sync/src/config.ts
plugins/instagram-sync/src/cron.ts
```

`config.ts` exports `InstagramSyncConfig` and `loadConfig(config)`. Defaults
match the shell script: the same saved feed, the same `-A 300` budget, the same
6-hourly cron. `workDir` derives from `ctx.config.galleryRoot`, so it follows
`DATA_ROOT` automatically.

`cron.ts` exports `parseCron`, `matchesCron`, `nextRun`. 5 fields; `*`, step
(`*` slash `n`), `a-b`, `a,b`, integers; day-of-week 0 and 7 are both Sunday.
When both day fields are restricted the match is their union (standard cron).

**Two bugs found by the tests while writing this:**

- `nextRun` originally re-parsed the expression on every scanned minute. With a
  366-day horizon that is ~527 k parses — the "never matches" case took over
  five seconds. Fixed by parsing once and matching against the parsed form.
- `*/n` written inside a JSDoc block terminated the comment (`*/` closes it),
  which broke the whole file at compile time. Reworded to avoid the sequence.

**Verify** — `server/test/instagram-sync-cron.test.ts`, 8 tests: the default
expression, step syntax, Sunday handling, the day-field union, malformed
expressions, `nextRun`, and the impossible-date case.

---

## Step 2 — State in `app_settings`

**Files**

```
plugins/instagram-sync/src/state.ts
```

Two keys, named to match the existing convention in
`server/src/constants/app-setting-keys.ts`:

- `instagram_sync.last_run` — a JSON blob `{at, status, downloaded, skipped, error, durationMs}`.
- `instagram_sync.gallery_dl_version` — the installed gallery-dl version.

`readLastRun()` tolerates a missing or corrupt value and returns a neutral
default rather than throwing.

---

## Step 3 — Cookie handling

**Files**

```
plugins/instagram-sync/src/cookie.ts
```

`parseCookieFile` (Netscape format, comments ignored), `validateCookie`
(must carry a `sessionid` scoped to `.instagram.com`), `readCookieFile`,
`writeCookieFile` (temp file → `chmod 0600` → rename), `readCookieUpdatedAt`.

**Verify** — `server/test/instagram-sync-cookie.test.ts`: parsing, the three
rejection paths, and that the written file has mode `0600`.

---

## Step 4 — gallery-dl locator + version probe

**Files**

```
plugins/instagram-sync/src/galleryDl.ts
```

`readInstalledVersion(root)` reads `<root>/current/gallery_dl/version.py` and
pulls `__version__` out of it with a regex — cheaper and safer than spawning
Python to ask. `compareVersions` compares numerically with zero padding, so
`1.32` and `1.32.0` are equal.

**The trap this encodes:** `PYTHONPATH` must point at the directory that
*contains* the `gallery_dl` package, so the `current` symlink targets the
**version directory**:

```
PYTHONPATH=<root>/current              → 1.32.19   ✅
PYTHONPATH=<root>/current/gallery_dl   → ModuleNotFoundError ❌
```

**Verify** — version comparison, the floor check (`1.32.17`), reading a
version off disk, and `null` when nothing is installed.

---

## Step 5 — The updater

**Files**

```
plugins/instagram-sync/src/galleryDlUpdater.ts
```

`fetchLatestRelease()` queries `https://pypi.org/pypi/gallery-dl/json` and
picks the sdist, carrying PyPI's own `sha256` digest.

`installRelease(release, root)`:

1. download the sdist to a temp file inside `<root>`;
2. **verify the sha256** against the digest PyPI published — a mismatch throws
   and leaves the active version untouched;
3. extract with `tar -xzf … --strip-components=1`, falling back to Python's
   `tarfile` with `filter='data'` if `tar` is unavailable;
4. extract into a scratch dir first, so a failed extraction never leaves a
   half-written version directory;
5. **smoke-test** `python3 -m gallery_dl --version` against the new install —
   a version that cannot report its own version is not activated;
6. flip the symlink **atomically** (`current.tmp` → `rename` over `current`);
7. `pruneVersions` keeps the active version and one spare.

`latestKnownVersion(force?)` caches the PyPI version for 30 minutes so
`GET /status` can report it without hitting PyPI on every 10-second poll. A
failed lookup is cached too, so an offline server does not retry per request.

---

## Step 6 — The fetcher

**Files**

```
plugins/instagram-sync/src/fetcher.ts
```

`buildArgs()` produces the exact argv:

```
-m gallery_dl --config-ignore --download-archive <archive> --cookies <cookie>
  -d <galleryRoot> -o extractor.instagram.directory=["{username}"]
  -A <abortAfterSkips> <sourceUrl>
```

Two details that are easy to get wrong, both verified against the real binary:

- `-o extractor.instagram.directory=["{username}"]` is **one argv element**. If
  it is shell-interpolated the braces break and gallery-dl dies with
  `DirectoryFormatError: Single '{' encountered in format string`.
- the flag is `--config-ignore`; there is no `--no-config`.

`parseStdout()` splits gallery-dl's output: a `# ` prefix means the file was
**skipped**, no prefix means it was **downloaded**. The unprefixed lines are
exactly the files the scanner has to index.

`runGalleryDl()` spawns via `execFile` (no shell) with `PYTHONPATH` pointing at
the active install, `cwd` inside the work dir, and a **64 MB** stdout buffer —
the default 1 MB buffer kills the child with `ENOBUFS` on a large library. A
non-zero exit still leaves usable stdout (gallery-dl aborts the extractor after
the `-A` budget, which is a normal outcome), so the catch block re-parses
stdout before declaring failure.

`classifyError()` maps stderr to a status: `topsearch` → `gallery-dl-too-old`,
`login_required`/401/403/challenge → `session-expired`, anything else → `error`.

**Verify** — stdout parsing (downloaded vs. skipped, empty output) and error
classification.

---

## Step 7 — Index the new files

**Files**

```
plugins/instagram-sync/src/indexer.ts
```

`toRelativePaths` makes gallery-root-relative, posix-separated paths (matching
`getRelativeGalleryPath`, `server/src/utils/path-utils.ts:74`). `indexDownloaded`
drops files whose extension the scanner does not support (`.heic`) and calls
`scannerService.scanChangedPaths(paths, 'instagram-sync')`.

`scanChangedPaths` needs **file** paths, not folder paths — it derives the
affected folder via `path.posix.dirname` (`server/src/services/scanner-service.ts:2047`).

---

## Step 8 — The scheduler

**Files**

```
plugins/instagram-sync/src/scheduler.ts
```

A 60-second tick plus a one-shot first tick offset by a random amount, so a
fleet of servers does not stampede Instagram at the same minute.

Guard rails:

- **no overlap** — a run in progress blocks the next tick;
- **skip when the scanner is busy** — `scannerService.getProgress().isScanning`,
  the same check `api.ts:1368` uses to refuse a concurrent rescan;
- the minute is remembered so a tick that matches twice does not run twice.

`runSyncNow()` validates the cookie before spawning anything (missing or
invalid → the run fails immediately with `session-expired`, no gallery-dl
invocation), then runs gallery-dl, indexes what came down, and persists the
outcome.

---

## Step 9 — Plugin entry

**Files**

```
plugins/instagram-sync/src/index.ts
```

`register(ctx)` creates the working set, registers the routes and starts the
scheduler. `INSTAGRAM_SYNC_ENABLED=0` disables the plugin entirely.

**Verify** — a direct import + `register()` smoke: the manifest, all five
routes, and the computed next run.

---

## Step 10 — API routes

**Files**

```
plugins/instagram-sync/src/api.ts
```

| method | path | auth |
|---|---|---|
| `GET` | `/status` | any user |
| `POST` | `/run` | `canManageLibrary` |
| `POST` | `/cookie` | `canManageLibrary` |
| `GET` | `/gallery-dl/check` | any user |
| `POST` | `/gallery-dl/update` | `canManageLibrary` |

The plugin route contract takes a single `RequestHandler`, so the capability
guard and the handler are composed by `withCapability()` rather than passed as
an array.

`GET /status` reports the enabled flag, the source URL, the cron, the next run,
whether a run is in flight, the gallery-dl versions (installed / latest /
minimum / update-available), the cookie state (**presence and validity only —
never its contents**), the archive entry count, and the last run.

`POST /cookie` takes the raw Netscape file as a **`text/plain` body**, validates
it, and writes it atomically with mode `0600`. It never echoes the cookie back.

**Server change this required.** `server/src/app.ts` only mounted
`express.json()`, and Express 5's `json()` only parses `application/json` — a
`text/plain` body arrived as `req.body === undefined` and every upload 400'd.
The fix is one scoped middleware in `createApp()`:

```ts
app.use('/api/plugins', express.text({ type: 'text/plain', limit: '256kb' }));
```

It is scoped to the plugin mount point and bounded, so it cannot be used to push
an unbounded payload at the server. `createApp()` runs before
`pluginHost.mountRoutes(app)`, so the middleware is in place for plugin routes.

---

## Step 11 — Web UI

**Files**

```
client/src/api/instagram-sync.ts
client/src/views/InstagramSyncView.vue
client/src/router/index.ts        (route added)
client/src/locales/{en,es,zh}.json (instagramSync block added)
client/src/views/SettingsView.vue  (link added)
```

`/settings/instagram`, guarded by `canAccessSettings`. The view shows the
status, the last run, and the three actions (**Update gallery-dl**, **Run sync
now**, **Upload cookie**), polls `/status` every 10 s, and stops on unmount.
A `409` (a run is already going) is shown as information, not an error. The
cookie is read with `file.text()` and POSTed as `text/plain`; its contents are
never rendered.

`SettingsView.vue` gained a card linking to the new route — otherwise the page
would be reachable by URL only.

**Verify** — `vue-tsc --noEmit` clean, `vite build` clean, and the locale
key-parity test passes for all three languages.

---

## Step 12 — Adopt the existing library

One-time, per server.

```bash
# the archive — byte-identical to the pvei original (md5 verified)
scp -i ~/.ssh/localinfra pvei:/mnt/6T/offline/reels/archive.insta.txt \
  root@10.0.36.37:/opt/foldergram-data/gallery/.instagram-sync/archive.sqlite

# the cookie — a live session, mode 0600
scp -i ~/.ssh/localinfra pvei:/mnt/6T/offline/reels/cookies.firefox-private.txt \
  root@10.0.36.37:/opt/foldergram-data/gallery/.instagram-sync/cookies.txt
ssh -i ~/.ssh/localinfra root@10.0.36.37 \
  "chmod 600 /opt/foldergram-data/gallery/.instagram-sync/cookies.txt"
```

gallery-dl itself is installed by the Web UI's **Update gallery-dl** button (the
same code path the updater uses), so there is no separate install step.

### 12c. The gallery must be writable by the server

The gallery is a shared btrfs volume (see `README.md` for the full picture):
`pvei` writes to it over NFS as real host root, while the server is an LXC
container whose uid map is `0 → 100000`. The 10,457 author directories that
`pvei` created as uid 0 are therefore **unwritable** from the server — gallery-dl
fails on them with `PermissionError … .mp4.part`, and the sync silently
downloads nothing for those authors.

The fix is one metadata operation on the storage owner:

```bash
# on pved1
cd /mnt/6T/offline/reels/gallery-dl/instagram
find . -maxdepth 1 -mindepth 1 -type d -uid 0 -print0 | xargs -0 -r chown -R 100000:100000
```

After that every author directory is owned by the uid the server maps to its
own root, and the server can write into all of them.

`yt-dlp` is installed on the server as well (`apt-get install -y yt-dlp`):
without it gallery-dl logs a fallback notice on every run, and some Instagram
CDN variants are only reachable through the yt-dlp downloader.

**No archive back-fill is needed.** gallery-dl's `skip: true` also skips files
that already exist on disk, even when they are absent from the archive —
verified by planting a file with a 2020 mtime and confirming it was skipped
(not re-downloaded, mtime untouched). The 23,529 on-disk files the ledger
misses are therefore covered by the filesystem check, and staging is not
needed at all.

---

## Step 13 — Deployment

Two changes, both in `CLAUDE.md`:

1. A new **Plugins** section — `plugins/` is **not** copied by the existing
   steps, so a new plugin never reaches the server without it.
2. The plugin rsync added to the "Both at once" block.

```bash
rsync -az --delete -e "ssh -i ~/.ssh/localinfra" \
  plugins/instagram-sync/dist/ root@10.0.36.37:/opt/foldergram/plugins/instagram-sync/dist/
ssh -i ~/.ssh/localinfra root@10.0.36.37 "systemctl restart foldergram"
```

---

## What was NOT done, and why

- **No staging directory.** Direct download into the gallery is safe (see
  `PLAN.md` §3) and removes a 541 GB copy plus a cross-device rename.
- **No archive back-fill script.** `skip: true` covers it.
- **No DB migration for the plugin.** Run state lives in `app_settings`.
- **No source CRUD API.** v1 has one configured source.
- **No per-source run history.** The state blob is enough for one source.

---

## Bugs found by running it against the live server

Each of these was found by deploying and running, not by reading the code.
Every one now has a regression test.

1. **The updater put the package one level too high.** It renamed the
   extracted `gallery_dl` package *onto* the version directory, so the package
   landed at `versions/<v>/__init__.py` instead of
   `versions/<v>/gallery_dl/__init__.py`. `PYTHONPATH` points at the version
   directory, so the import failed and the smoke test rejected every install.
   The package must live **inside** the version directory.
   → `installExtractedPackage()` extracted and tested.

2. **`-m gallery_dl` was passed twice** — once by `buildArgs()` and once by
   the spawn. gallery-dl exited with `unrecognized arguments: -m …`.
   → `buildArgs()` now returns only gallery-dl's own arguments; asserted by a test.

3. **A fully-skipped run was reported as failed.** The steady state — every
   file already downloaded, nothing new, empty stderr — went through
   `classifyError()`, which returns a generic error for anything it does not
   recognise. The success path now decides on the per-file failures alone.
   → `statusForSuccessfulRun()` extracted and tested.

4. **Partial failures were reported as success.** gallery-dl keeps going after
   a file fails, so a run could download most of a batch and still fail on the
   rest — and the plugin called that `ok`. The permission problem in §12c was
   invisible because of this.
   → `summariseFailures()` groups the failures and the run is reported as an
   error when there are any.

5. **`text/plain` bodies were never parsed.** `server/src/app.ts` only mounted
   `express.json()`, and Express 5's `json()` only parses `application/json`,
   so the plugin's cookie upload always arrived as `req.body === undefined`.
   → a scoped `express.text()` for `/api/plugins`.
