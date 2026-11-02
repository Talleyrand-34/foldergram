# instagram-sync plugin — plan

Scheduled Instagram → Foldergram sync. Replaces the `insta.sh` script that runs
`gallery-dl` by hand on `pvei`.

**v1 scope:**
- Latest gallery-dl, **self-updatable from the Foldergram Web UI**.
- **One source:** the saved-posts feed from the script —
  `https://www.instagram.com/rodantes_6/saved/`.
- The plugin owns the gallery-dl working set: `cookies.txt`, `archive.sqlite`
  (adopted from `archive.insta.txt`), and the downloaded media.

Status: proposal. Nothing implemented yet.

Every claim below was verified by running the code against the live servers
(`10.0.36.37`, `pvei`) on 2026-10-31/11-01. Commands are reproducible.

---

## 1. The script being replaced

`root@pvei:/mnt/6T/offline/reels/insta.sh`:

```bash
elements=(
"https://www.instagram.com/rodantes_6/saved/"
)

echo "All elements:"
for element in "${elements[@]}"; do
    ./gl -A 300 --download-archive ./archive.insta.txt --cookies ./cookies.firefox-private.txt "$element"
done
```

### Runtime facts on `pvei` (verified)

| Fact | Value | How verified |
|---|---|---|
| `./gl` | **gallery-dl 1.31.10**, ELF 64-bit x86-64, 24 MB, stripped (PyInstaller onefile) | `./gl --version` |
| `./archive.insta.txt` | **Not a text file — a SQLite 3 database.** Schema: `CREATE TABLE archive (entry TEXT PRIMARY KEY) WITHOUT ROWID`. **104,931 entries, 4.2 MB.** Entry format: `instagram<media_id>`, e.g. `instagram1010302736121227800`. | `file`, `sqlite3` |
| `./cookies.firefox-private.txt` | Netscape HTTP Cookie File, 751 bytes. `sessionid`, `csrftoken`, `ds_user_id`, `rur`, `mid`, `ig_did`, `datr`, `dpr`, `wd` for `.instagram.com`. **Live session credential.** | `cut -f6` |
| `./gallery-dl.conf` | 33 KB stock default dump; only meaningful setting is `"base-directory": "./gallery-dl/"` | grep |
| Existing media tree | `gallery-dl/instagram/<username>/<media_id>.<ext>` — 27,195 creator dirs, 115,551 files, 541 GB | `find` |
| Extensions present | `mp4` 74,247 · `jpg` 32,715 · `webp` 8,542 · `png` 41 · `part` 3 · `m4a` 3 | `find | sed` |

### ⚠️ `-A 300` is NOT a post cap — it is a skip-abort

From `gallery_dl/option.py:744`:

```
-A, --abort N[:TARGET]   Stop current extractor(s) after N consecutive
                          file downloads were skipped.
```

`-A 300` means: *stop the extractor once 300 files in a row were skipped as
already-downloaded*. It is a "you have caught up, stop early" optimisation, and it
only works if the skip signal is reliable.

**Verified with the real archive and the real cookie:**

```
$ python3 -m gallery_dl -A 300 -d /tmp/savedtest \
      --download-archive /tmp/arch_real.sqlite --cookies cookies.txt \
      'https://www.instagram.com/rodantes_6/saved/'
300        ← skipped lines (the abort budget)
32         ← files actually downloaded
```

So the archive + `-A 300` combination is what makes an incremental run cheap.
This is why the archive must be adopted **byte-identical**.

---

## 2. The script is currently broken — and why

**Profile URLs fail. Only `saved/` URLs work.**

```
$ ./gl --no-download --cookies ./cookies.firefox-private.txt 'https://www.instagram.com/nukakitten/'
[instagram][error] HttpError: '404 Not Found' for 'https://www.instagram.com/web/search/topsearch/?query=nukakitten'
```

Identical failure with and without cookies, so it is not an auth problem. The
endpoint itself is dead:

```
GET https://www.instagram.com/web/search/topsearch/?query=nukakitten   → 404
```

gallery-dl 1.31.x resolves a username to a user-id via `/web/search/topsearch/`.
Instagram removed that endpoint. This kills the 67 creator-profile URLs in
`creators-insta.sh` — but **not** the `saved/` URL this plugin targets, because the
saved feed does not need user-id resolution.

**This is exactly why the v1 scope is the saved feed**: it is the one source that
survives on the old binary, and it is the one the user wants.

**The fix is a gallery-dl upgrade.** Version 1.32.17 removed the `topsearch`
lookup entirely (changelog: *"remove `user-strategy` option"*) and resolves users
by scraping `"profile_id":"` from the public profile page instead. Verified:

| Version | `topsearch` in `instagram.py` | Profile URL resolves? |
|---|---|---|
| 1.31.10 (`pvei` binary) | yes | ❌ 404 |
| 1.32.0 – 1.32.16 | yes | ❌ (still uses it) |
| **1.32.17+** | **no** | ✅ |
| **1.32.19** (latest, 2026-10-31) | no | ✅ — verified working end-to-end on the server |

**Therefore: pin gallery-dl ≥ 1.32.17.**

---

## 3. The design: gallery-dl downloads straight into the gallery

### No staging directory. No move step. No archive back-fill.

The previous draft of this plan staged downloads outside the gallery and moved
them in, and proposed back-filling the archive with the ~20 % of on-disk files it
was missing. **Both are unnecessary**, and the proof is a single gallery-dl
behaviour:

> gallery-dl's `skip: true` (the default) checks whether the **destination file
> already exists on disk** and skips the download if it does.

Verified — a file that exists on disk but is **not** in the archive is skipped,
and is not rewritten:

```
$ ./gallery_dl -d /tmp/na2 -o 'extractor.instagram.directory=["{username}"]' \
      --download-archive /tmp/na2_arch.sqlite --cookies cookies.txt \
      'https://www.instagram.com/00the_black_sheep00/'
# /tmp/na2/00the_black_sheep00/3187543501486647499.mp4     ← "# " = SKIPPED

$ ls -la --time-style=full-iso .../3187543501486647499.mp4
-rw-r--r-- 1 root root 1646273 2020-01-01 00:00:00 +0100    ← mtime untouched
```

The file was planted with `touch -d '2020-01-01'`; the mtime is still
2020-01-01 after the run. It was **skipped, not re-downloaded**. Same result for
the archive-covered files.

So when gallery-dl downloads **directly into the gallery**, both dedup layers
work on their own:

| Layer | Mechanism | Covers |
|---|---|---|
| Archive | `archive.check()` → skip before any HTTP request | media downloaded in a previous run |
| On-disk | `pathfmt.exists()` → skip before writing | everything already in the gallery, archived or not |

The 23,529 files missing from the archive are covered by the second layer. **No
back-fill script is needed.**

Two further wins from downloading directly:

- **No rename step.** The move from staging to the gallery would have been a
  cross-device copy for 541 GB.
- **No 541 GB staging copy.** The staging tree would have had to hold every
  file before it could be moved.

### How the plugin learns which files are new

gallery-dl prints one line per file to stdout, prefixed with `# ` when the file
was **skipped** and unprefixed when it was **downloaded** (`gallery_dl/output.py:54`,
`CHAR_SKIP = "# "`). Verified:

```
$ python3 -m gallery_dl -d /tmp/fmt3 -o 'extractor.instagram.directory=["{username}"]' … > out.txt
$ grep -c '^# ' out.txt   → 1      (skipped)
$ grep -vc '^# ' out.txt  → 300    (downloaded)
```

So the plugin parses stdout: unprefixed lines are the newly-downloaded absolute
paths. Those become the relative paths handed to the scanner. No filesystem diff,
no mtime heuristics.

### The `.part` files are safe

gallery-dl writes `<name>.mp4.part` while downloading and renames it into place
on completion (`gallery_dl/path.py:359-410`: `os.replace(self.temppath, self.realpath)`
— atomic). The scanner ignores them: `isSupportedMediaFile` matches on the
**extension**, and `path.extname("x.mp4.part")` is `.part`, which is in neither
`SUPPORTED_IMAGE_EXTENSIONS` nor `SUPPORTED_VIDEO_EXTENSIONS`
(`server/src/utils/image-utils.ts:6-7`).

**But the scanner could still race a rename.** The window is: `.part` renamed to
`.mp4`, scanner walks the directory. Two mitigations, both needed:

1. The plugin only hands the scanner the paths it parsed from stdout — files it
   knows are complete.
2. A scan that happens to see a file mid-flight indexes a **complete** file,
   because the rename is atomic. There is no partially-written `.mp4` visible to
   the scanner, ever.

The scanner only ever sees either `X.mp4.part` (ignored) or `X.mp4` (complete).

### Output layout — the exact gallery-dl invocation

The existing library is at `galleryRoot/<username>/<file>` — **flat, no
`instagram/` level**. (The `instagram/` prefix was stripped when the tree was
copied to the server; both sides have 27,195 dirs and 115,551 files, and a sample
file matches byte-for-byte: `490fe26e5c9b30ab119b0334aee10949`.)

`-d` (destination) places files under `<dest>/<category>/<username>/`;
`--directory` flattens to `<dest>/<file>`. Neither matches. The correct lever is
the per-extractor directory template, verified:

```
$ python3 -m gallery_dl -d /tmp/dtest -o 'extractor.instagram.directory=["{username}"]' …
/tmp/dtest/nukakitten/4019457935986192455_4019455833449738181.jpg
```

So the plugin invokes:

```
<python3> -m gallery_dl
          --config-ignore                      # don't inherit any host config
          --download-archive <workDir>/archive.sqlite
          --cookies <workDir>/cookies.txt
          -d <galleryRoot>
          -o extractor.instagram.directory=["{username}"]
          [-A <abortAfterSkips>]
          <sourceUrl>
```

Notes:
- `--config-ignore` (not `--no-config` — that flag does not exist) suppresses
  `/etc/gallery-dl.conf`, `~/.config/gallery-dl/config.*`, `~/.gallery-dl.conf`, and
  the PyInstaller-dir config (`gallery_dl/config.py:59-73`).
- `-o extractor.instagram.directory=…` is a JSON value; it must be passed as a
  single argv element, not shell-interpolated (a naive `-o '…directory=["{username}"]'`
  fails with `DirectoryFormatError: Single '{' encountered in format string`).
- The child is spawned with `execFile` (no shell), `PYTHONPATH` pointing at the
  active gallery-dl install, and `cwd` inside the work dir.

### The archive — adopted byte-identical

Verified on the server against a copy of `pvei`'s archive:

- Schema is **byte-compatible** between 1.31.10 and 1.32.19:
  `CREATE TABLE archive (entry TEXT PRIMARY KEY) WITHOUT ROWID`
  (`gallery_dl/archive.py:73`). gallery-dl detects SQLite by content, so the
  `.txt` extension is irrelevant.
- Entry format is identical: `instagram<media_id>`.
- A run with `pvei`'s archive against a fresh destination downloaded 167 new files
  and grew the archive 104,931 → 105,098 — it did **not** re-download the ~104 k
  already-archived items.

The archive is the ledger of what has been downloaded. Adopting it byte-identical
preserves the `-A 300` budget's meaning across the migration.

Archive-key detail, for anyone reading the data: for a carousel file
`postid_mediaid.jpg` the archived key is the **media** id (the last
`_`-separated segment), not the post id. For `nukakitten`, 2 of 946 files were
unmatched by last-id vs. 725 unmatched by first-id.

---

## 4. The gallery-dl working set

```
<galleryRoot>/.instagram-sync/
  cookies.txt          0600, the live session
  archive.sqlite       the dedup ledger (adopted from archive.insta.txt)
  gallery-dl/
    versions/
      1.32.19/
        gallery_dl/            ← the package
    current -> versions/1.32.19
```

### Why inside the gallery root

**The gallery is a separate btrfs mount**; everything else under
`/opt/foldergram-data` is on the root filesystem. Verified with `stat -f`:

```
/opt/foldergram-data          ext2/ext3   ← root fs (loop3, 6.4 G, 2.0 G free)
/opt/foldergram-data/gallery  btrfs       ← /dev/sdb, 5.5 T, 228 G free (96 % used)
```

`/dev/sdb` is mounted **only** at `/opt/foldergram-data/gallery`
(`subvol=/@/@multimedia`).

The root filesystem was **100 % full** on 2026-10-19 — that is what killed
Postgres (`could not write to file "pg_wal/xlogtemp.26656": No space left on
device` → `Connection terminated unexpectedly` → `foldergram.service` exit 1). It
has since been resized to 6.4 G / 2.0 G free. The working set belongs on the
5.5 T disk, not next to Postgres.

### Why a hidden directory

The scanner walks `galleryRoot` and would try to index `cookies.txt` and
`archive.sqlite`. It skips them because `isHiddenPath`
(`server/src/utils/path-utils.ts:24`) matches any path segment starting with
`.`, and `scanner-service.ts:952` skips those entries.

`.instagram-sync` is a hidden segment → invisible to the scanner, inside the
btrfs mount → same filesystem as the gallery.

### Cookies

The cookie is a **live Instagram session**. It expires and cannot be refreshed
without a human logging in. This is the single biggest operational risk.

- Stored at `<workDir>/cookies.txt`, mode `0600`, **never** in the DB, never in
  logs, never returned by any route.
- Seeded on first run from `INSTAGRAM_COOKIE_FILE` (a mounted path) if present.
- Refreshable through an admin-only route `POST /cookie` that accepts a pasted
  Netscape cookie file and writes it atomically (write `.tmp` → `chmod 0600` →
  `rename`). Without this, every expiry needs a server restart.
- **Validated before every run**: must parse as a Netscape cookie file and contain a
  `sessionid` for `.instagram.com`. If not → the run fails fast with
  `cookie-missing` / `cookie-expired` and **no** gallery-dl invocation.
- gallery-dl's own failure modes are mapped: a `login_required` / 403 / "challenge"
  in the child's output → status `session-expired`, surfaced in `/status`.

The cookie currently on `pvei` **works** for `saved/` (verified: a live run
returned fresh media IDs `4019…`, `4018…`).

---

## 5. gallery-dl: vendored, versioned, updatable from the Web UI

### Why vendored rather than installed

The server has Python 3.13.5 and `requests` 2.32.3, but **no `pip` and no
`ensurepip`** (`import ensurepip` → `ModuleNotFoundError`; `apt-cache policy
python3-pip` → candidate `25.1.1+dfsg-1` is available but adds a system package).
The `pvei` PyInstaller binary is 24 MB and is the **wrong version** (1.31.10).

`gallery_dl/` is **3.4 MB of pure Python** with exactly one dependency
(`requests`, already present). Verified on the server: extract the sdist, put the
package dir on `PYTHONPATH`, and `python3 -m gallery_dl --version` → `1.32.19`;
profile URLs resolve; the archive is honoured; the output layout is correct.

Note the sdist's top-level `data/` directory is **not** needed at runtime — it
only holds the stock `gallery-dl.conf`, which the plugin overrides with
`--config-ignore` anyway.

### Layout — versioned directories + a symlink

```
<workDir>/gallery-dl/
  versions/
    1.32.19/
      gallery_dl/            ← the package
  current -> versions/1.32.19
```

Run it with `PYTHONPATH=<workDir>/gallery-dl/current`.

**Important detail, verified:** `PYTHONPATH` must point at the directory that
*contains* the `gallery_dl` package, so the symlink target is the **version
directory**, not the package directory. Pointing `PYTHONPATH` at a symlink *to the
package* fails with `ModuleNotFoundError: No module named 'gallery_dl'` — because
Python then looks for `current/gallery_dl/`.

```
PYTHONPATH=/tmp/gdi2/current python3 -m gallery_dl --version   → 1.32.19   ✅
PYTHONPATH=/tmp/gdi2/current/gallery_dl python3 -m gallery_dl  → ModuleNotFoundError ❌
```

### The updater (Web UI action)

`POST /api/plugins/instagram-sync/gallery-dl/update` → admin only.

Algorithm:

1. `GET https://pypi.org/pypi/gallery-dl/json` → `info.version` (latest) and
   `urls[]` with the sdist URL **and its `sha256` digest**. Verified reachable
   from the server: `pypi_json=200`, `files.pythonhosted=200`.
2. If `latest` == the active version → return `{updated: false, version}`.
3. Download the sdist (`gallery_dl-<v>.tar.gz`, ~765 KB) into a temp file.
4. **Verify the sha256 against the digest PyPI published.** Never trust the
   download. Node's `crypto.createHash('sha256')` is enough.
5. Extract. Two options, both verified on the server:
   - `tar -xzf <file> -C <dir> --strip-components=1` → yields `<dir>/gallery_dl/`
     directly (plus docs/tests, which are then not copied). `tar` is `Priority:
     required` on Debian, so it is always present.
   - Python's stdlib `tarfile`:
     `tarfile.open(f).extractall(dest, filter='data')` — `filter='data'` is the
     safe-mode extraction that rejects absolute paths and `..`.
6. Move `<dir>/gallery_dl` → `versions/<v>/gallery_dl`.
7. **Smoke-test the new version before switching:**
   `python3 -m gallery_dl --version` with `PYTHONPATH` pointed at the new dir —
   must print the expected version.
8. Flip the symlink **atomically**: create `current.tmp` → `versions/<v>`, then
   `rename` over `current`. Verified atomic on this box.
9. Prune old versions, keeping the current one and the previous one.
10. Record the new version in `app_settings`.

If any step fails, the symlink is untouched and the old version keeps working.

### Version floor

The plugin must refuse to run against a gallery-dl older than **1.32.17**, because
those versions cannot resolve the source's author usernames. The floor is enforced
at spawn time: the resolved version is compared against `MIN_GALLERY_DL_VERSION`
and the run fails with `gallery-dl-too-old` if it is below.

---

## 6. Foldergram seams this plugin can use (verified)

### Plugin contract — `server/src/plugins/types.ts`

```ts
export interface Plugin {
  manifest: PluginManifest;
  register: (ctx: PluginContext) => void | Promise<void>;
}

export interface PluginContext {
  config: typeof appConfig;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  hooks: HookEmitter;
  addRoutes: (routes: PluginRoute[]) => void;
}
```

The file's own header states the rule that shapes everything below:

> Plugins may import server modules directly (e.g. db/repositories.ts, services/...) — there is no sandbox.
> Plugins run in-process. A crash in one plugin will not crash the host… A blocking call in a hook will block the scanner.

### Loader — `server/src/plugins/host.ts`

- Reads `plugins/<name>/manifest.json`, dynamic-imports `entry`, calls `register(ctx)`.
- Entrypoint candidates in order: `manifest.entry` → `index.ts` → `index.js` (`host.ts:108-118`).
- `PLUGINS_DIR` default `path.join(repositoryRoot, "plugins")` (`host.ts:53-55`); `PLUGINS_ENABLED=0` disables all plugins.
- Routes mounted at `/api/plugins/<name><path>` (`host.ts:202-214`).

**Import path convention.** The ai-analysis plugin imports server modules through the
**built** server output, not source:

```ts
import { databaseManager } from "../../../server/dist/db/database.js";
import type { PluginContext } from "../../../server/dist/plugins/types.js";
```

Verified on the deployed server: `/opt/foldergram/server/dist/plugins/types.js` exists.
The plugin must use the same `../../../server/dist/...` form.

### Boot order — `server/src/index.ts`

```
:55  await scannerService.initialize();
:56  await pluginHost.loadAll();        ← plugin register() runs here
:58  pluginHost.mountRoutes(app);
:80  server.listen(...)
:82  void scannerService.handleStartup("startup")   ← startup scan runs AFTER plugins load
```

### Auth — `server/src/app.ts:53`

```ts
app.use('/api', blockPublicDemoMutations, requireTrustedMutationRequest, requireApiAuthentication, apiRouter);
```

Auth is applied at the `/api` mount, so every plugin route is authenticated when
`manifest.requireAuth !== false`. Admin-only routes additionally use
`requireCapability` from `server/src/middleware/auth-protection.ts:86` — importable
by the plugin.

### There is no scheduler

`server/package.json` dependencies: `chokidar`, `dbmate`, `dotenv`, `exifr`, `express`,
`p-limit`, `pg`, `sharp`, `zod`. **No cron library.** `setInterval` appears twice in
the server: the rate-limit cleanup (`middleware/rate-limit.ts:18`) and the scanner
heartbeat (`services/scanner-service.ts:723`). The ai-analysis plugin runs its own
`setInterval` worker (`plugins/ai-analysis/src/worker.ts:72`).

**Consequence:** the plugin owns its own timer. There is no host seam for a job registry.

### The file watcher is development-only

`server/src/services/watcher-service.ts:26`:

```ts
if (this.watcher || !appConfig.isDevelopment) {
  return;
}
```

In production (`NODE_ENV=production`) **nothing picks up newly written files.**
The plugin must trigger indexing itself:

```ts
// server/src/services/scanner-service.ts:669 — public
async scanChangedPaths(relativePaths: string[], reason = 'watcher'): Promise<ScanRunRecord | undefined>
```

`scanChangedPaths` requires **file** paths, not folder paths
(`scanner-service.ts:2047`: `if (!isSupportedMediaFile(path.basename(relativePath))) continue;`),
and derives the affected folder via `getSourceFolderPathFromRelativePath`
(`server/src/utils/path-utils.ts:78` → `path.posix.dirname`).

Relative paths are gallery-root-relative, posix-separated
(`getRelativeGalleryPath` → `normalizePath(path.relative(galleryRoot, absolutePath))`,
`server/src/utils/path-utils.ts:74-76`).

### Media pipeline

`scannerService.scanChangedPaths()` → `performIncrementalScan(relativePaths, reason)` →
rows in `images` (`server/db/migrations/sqlite/000001_baseline.sql:21`):

| column | note |
|---|---|
| `relative_path` | `TEXT NOT NULL UNIQUE` — the identity of the media |
| `absolute_path`, `folder_id`, `asset_key` | |
| `filename`, `extension`, `file_size`, `mtime_ms` | |
| `width`, `height`, `mime_type`, `media_type` | `media_type` is `'image'` or `'video'` |
| `duration_ms`, `is_animated` | video |
| `checksum_or_fingerprint` | `TEXT NOT NULL` |
| `taken_at`, `taken_at_source`, `exif_json` | |
| `thumbnail_path`, `preview_path`, `playback_strategy` | derivatives |
| `is_deleted`, `is_trashed` | soft delete / trash |

The scanner fingerprints a file as `relativePath:fileSize:mtimeMs`
(`createFingerprint`, `server/src/utils/image-utils.ts:24`). gallery-dl preserves
the **post's** timestamp as the file mtime (verified: a freshly downloaded file
carried the post date `2026-10-30 17:08:17`, not the download time) — so a
re-downloaded file has a stable fingerprint and the scanner does not re-derive
thumbnails for it.

**Supported extensions** (`server/src/utils/image-utils.ts:6-7`):

```ts
SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
```

Note `.heic` is **not** supported. gallery-dl 1.32.19 does emit `.heic` for some
carousels (observed: `...3859268378745967520.heic`). Such files land on disk and
are silently skipped by the scanner.

### Gallery root on disk

`server/src/config/env.ts:106` — `galleryRoot = <DATA_ROOT>/gallery`, default
`<repo>/data/gallery`. On the servers: `DATA_ROOT=/opt/foldergram-data`, so
`galleryRoot = /opt/foldergram-data/gallery`.

### Migrations

`server/db/migrations/{postgres,sqlite}/NNNN_name.sql`, applied at boot by
`node dist/scripts/migrate.js` (the `ExecStart` first step). **Plugin migrations live
in the server's migration directory**, not in the plugin — the ai-analysis plugin's is
`server/db/migrations/postgres/0011_ai_analysis.sql`. Current highest is `0019_low_quality_hq.sql`
in both drivers.

**v1 needs no migration.** There is one source and it is configured, not
user-managed, so the run state fits in `app_settings` — an existing store
(`appSettingsRepository`, `server/src/db/repositories.ts:2508`,
`app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`) with an existing
key-naming convention (`server/src/constants/app-setting-keys.ts`:
`scanner.last_successful_gallery_root`, `library.excluded_folders`, …).

Keys to add:

```ts
export const INSTAGRAM_SYNC_LAST_RUN_SETTING_KEY = 'instagram_sync.last_run';
export const INSTAGRAM_SYNC_GALLERY_DL_VERSION_SETTING_KEY = 'instagram_sync.gallery_dl_version';
```

`last_run` holds a JSON blob (`{at, status, downloaded, skipped, error, durationMs}`).
This keeps v1 out of the migration path entirely. If a per-source history is later
wanted, that is when a table earns its place.

### Build & packaging

- `pnpm-workspace.yaml` packages: `server`, `client`, `docs`. **`plugins/` is not a workspace package.**
- The ai-analysis plugin has its own `package.json` + `tsconfig.json`, compiled by
  `server/package.json` → `"build:plugins": "tsc -p ../plugins/ai-analysis/tsconfig.json"`.
- `Dockerfile`: `node:22-bookworm-slim`, installs **only ffmpeg**, then `COPY . .`
  (so `plugins/` **is** in the image) and `pnpm build`.

### Deployment reality (differs from the Docker docs)

The live servers do **not** run Docker — there is no `docker` binary and the unit is
plain systemd:

```
/etc/systemd/system/foldergram.service
  WorkingDirectory=/opt/foldergram/server
  ExecStart=/bin/sh -c 'node dist/scripts/migrate.js && exec node dist/index.js'
```

`/opt/foldergram/` is a git checkout with `node_modules` present, and the deployed
plugin lives at `/opt/foldergram/plugins/ai-analysis/` with a `dist/` build. Local
`plugins/ai-analysis/dist/index.js` and the deployed copy have the **same md5**
(`11afb0bf…`), so the deploy path is: build locally → copy `plugins/<name>/dist/`
to the server alongside `server/dist/`. `CLAUDE.md`'s deployment section currently
copies **only** `server/dist/` and `client/dist/` — **it does not copy `plugins/`**,
so the deployment step must be extended for this plugin.

The service runs as **root** (no `User=` in the unit) — so the plugin can write to
the working set and swap symlinks without extra permission plumbing.

### Auth surface for admin routes

`requireCapability('canAccessSettings', '…')` — the same guard
`server/src/routes/api.ts` uses for `/admin/rescan`.

### Client seams

- API client: `client/src/api/http.ts` exports `requestJson<T>(input, init)`. It
  auto-sets `x-foldergram-intent: 1` on mutating methods, so plugin routes work
  with `requireTrustedMutationRequest` for free.
- Existing plugin API client: `client/src/api/ai-analysis.ts` — the pattern to copy.
- Router: `client/src/router/index.ts` — `/settings` and `/settings/ai` exist;
  `/settings/instagram` would be the new sibling.
- Settings page: `client/src/views/SettingsView.vue` has five categories
  (`library`, `general`, `places`, `access`, `status`) with i18n labels in
  `client/src/locales/{en,es,zh}.json` under `settings.sections.*`.
- Dedicated-settings-page pattern: `client/src/views/AiSettingsView.vue` — a
  standalone route with a tab strip, reused components, and `meta.requiredCapability`.

---

## 7. Schedule (the internal cron)

No cron library exists and none is worth adding for one plugin. The plugin ships a
minimal 5-field cron matcher (~50 lines, `src/cron.ts`) supporting `*`, `*/n`,
`a-b`, `a,b`, and numeric fields — minute, hour, day-of-month, month, day-of-week.

Config:

| env | default | meaning |
|---|---|---|
| `INSTAGRAM_SYNC_CRON` | `17 */6 * * *` | every 6 h at :17 (off the hour on purpose) |
| `INSTAGRAM_SYNC_ENABLED` | `1` | `0` disables the timer entirely |
| `INSTAGRAM_SYNC_SOURCE_URL` | `https://www.instagram.com/rodantes_6/saved/` | the saved feed |
| `INSTAGRAM_SYNC_ABORT_AFTER_SKIPS` | `300` | the `-A` budget (see §1) |
| `INSTAGRAM_SYNC_TIMEOUT_MINUTES` | `45` | hard cap on the gallery-dl run |

Guard rails:
- **No overlap.** A run in progress blocks the next tick (boolean + next-tick skip).
- **Skip the tick if a scan is running** — `scannerService.getProgress().isScanning`
  is the same check `api.ts:1368` uses to refuse a concurrent rescan.
- The first tick is delayed by a small random offset so a fleet of servers doesn't
  stampede Instagram at :17.

---

## 8. Plugin API

Mounted at `/api/plugins/instagram-sync`. All authenticated (`requireAuth: true`).

| method | path | purpose | auth |
|---|---|---|---|
| `GET` | `/status` | active gallery-dl version, latest available version, cookie state (present/expired — **never** its contents), archive entry count, last run, next scheduled run | any user |
| `POST` | `/run` | trigger a sync now | `canAccessSettings` |
| `POST` | `/cookie` | upload a fresh Netscape cookie file (raw body, `text/plain`) | `canAccessSettings` |
| `GET` | `/gallery-dl/check` | query PyPI for the latest version without installing | any user |
| `POST` | `/gallery-dl/update` | download + verify + activate a newer gallery-dl | `canAccessSettings` |

`POST /cookie` must accept `Content-Type: text/plain` and write the file
atomically (write to `.tmp`, `chmod 0600`, `rename`). It must never echo the cookie
back, never log it, and never store it in the DB.

---

## 9. Files

```
plugins/instagram-sync/
  manifest.json           { name, version, description, entry: "dist/index.js", hooks: [], requireAuth: true }
  package.json            @foldergram/instagram-sync-plugin, private, type: module
  tsconfig.json           mirrors plugins/ai-analysis/tsconfig.json
  src/
    index.ts              default export Plugin; register(ctx) → load config, ensure work dir, start scheduler
    config.ts             env parsing + defaults
    cron.ts               minimal 5-field cron matcher + nextRun()
    cookie.ts             read/validate/write the Netscape cookie file
    galleryDl.ts          locate + version-probe the vendored gallery-dl
    galleryDlUpdater.ts   PyPI check / download / verify / extract / activate
    fetcher.ts            spawn gallery-dl, capture stdout, classify errors, extract new file paths
    indexer.ts            call scannerService.scanChangedPaths with the new relative paths
    state.ts              read/write run state via appSettingsRepository
    api.ts                the five routes
    scheduler.ts          timer + no-overlap guard
  test/  (or *.test.ts beside sources, matching the server's vitest convention)
  README.md
```

**`hooks: []`** — this plugin subscribes to nothing. `HookEvents` currently defines
only `"video.indexed"`, and the plugin must not react to it.

---

## 10. Implementation phases

See `IMPLEMENTATION.md` for the step-by-step build order.

### Phase 0 — Scaffolding
### Phase 1 — Fetch
### Phase 2 — Index
### Phase 3 — API
### Phase 4 — Web UI
### Phase 5 — Adopt the existing library
### Phase 6 — Deployment

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Cookie expiry.** Instagram sessions expire; the user must re-authenticate by hand. | Validate before every run; classify `login_required`/403 separately; surface `session-expired` in `/status` and the UI; `POST /cookie` to refresh without a redeploy. |
| 2 | **Wrong gallery-dl version.** 1.31.10 (the `pvei` binary) cannot resolve the saved feed's author usernames. | Enforce a **1.32.17 floor** at spawn time; the Web UI shows the active version and offers the update; the updater smoke-tests before activating. |
| 3 | **Archive loss.** A fresh archive re-downloads the whole library. | Adoption copies `archive.insta.txt` byte-identical; the plugin refuses to run when the archive file is missing. |
| 4 | **Wrong output layout → duplicated library.** Writing to `galleryRoot/instagram/<user>/` would split every creator folder. | The `-o extractor.instagram.directory=["{username}"]` invocation is pinned and covered by a test that asserts the produced path shape. |
| 5 | **The watcher is dev-only.** New files would never be indexed in production. | The plugin calls `scannerService.scanChangedPaths` itself, with the exact paths it parsed from gallery-dl's stdout. |
| 6 | **No sandbox.** A plugin bug can take the server down. | gallery-dl runs as a **child process** — a crash there kills the child, not the host. The plugin's own code is small and pure-ish. |
| 7 | **Partial files indexed.** | gallery-dl renames `.part` → final atomically; the scanner ignores `.part` (extension check); the plugin only hands over paths gallery-dl reported as complete. |
| 8 | **Rate limiting / IP ban.** The saved feed can be large. | `-A` budget; a long timeout; one run at a time. A 429 surfaces as `failed`, not a crash. |
| 9 | **Disk growth.** The library is already 541 GB and the data disk is 96 % full (228 GB free). | The plugin does not delete anything. Retention is out of scope for v1 — but the disk pressure is real. |
| 10 | **Terms of service.** Downloading saved posts is not sanctioned by Instagram. | The user is downloading their own saved content for personal use. Worth being aware of; not a blocker for a personal self-hosted gallery. |
| 11 | **`.heic` files are not indexed.** gallery-dl emits `.heic` for some carousels; Foldergram does not list `.heic` as supported. | Harmless (files land, are ignored by the scanner). Out of scope for v1. |
| 12 | **The plugin's own files land in the gallery tree.** `cookies.txt` and `archive.sqlite` sit inside `galleryRoot`. | They live under a hidden `.instagram-sync/` segment, which the scanner skips (`isHiddenPath`). Verified against `scanner-service.ts:952`. |

---

## 12. Open questions

1. **Update policy** — should the Web UI only *offer* the update, or apply it
   automatically on the next scheduled run? *Recommendation: offer it in the UI
   and apply on click; an automatic upgrade changes the tool under a running job.*
2. **Version floor vs. auto-upgrade.** If the active gallery-dl is below 1.32.17,
   should `POST /run` fail with `gallery-dl-too-old`, or should it self-heal by
   installing the latest first? *Recommendation: fail with a clear message and a
   one-click fix — self-healing hides a misconfigured install.*
3. **Where does the Web UI panel live?** A dedicated route `/settings/instagram`
   (like `/settings/ai`) or a new category inside `SettingsView.vue`? *Recommendation:
   dedicated route — the panel has its own state and the settings page is already
   five categories deep.*
4. **Should the source URL be editable in the UI?** v1 treats it as env config.
   *Recommendation: keep it env-only in v1; a single source does not need a UI.*
