# instagram-sync

Scheduled Instagram → Foldergram sync. Replaces the `insta.sh` script that runs
`gallery-dl` by hand on `pvei`.

## What it does

1. Runs a vendored **gallery-dl** against an Instagram saved-posts feed.
2. Downloads land **directly in the gallery** — no staging directory, no move
   step.
3. The files that came down are handed to Foldergram's scanner so they appear
   in the library immediately.
4. A **cron expression** drives the schedule; the plugin owns its own timer
   (the server has no cron library).
5. **gallery-dl can update itself** from the Web UI: the plugin queries PyPI,
   verifies the download against the digest PyPI published, extracts it,
   smoke-tests it, and only then flips the active symlink.

## Configuration

All optional; the defaults match the shell script this replaces.

| env | default | meaning |
|---|---|---|
| `INSTAGRAM_SYNC_ENABLED` | `1` | `0` disables the plugin entirely |
| `INSTAGRAM_SYNC_CRON` | `17 */6 * * *` | 5-field cron expression |
| `INSTAGRAM_SYNC_SOURCE_URL` | `https://www.instagram.com/rodantes_6/saved/` | the saved-posts feed |
| `INSTAGRAM_SYNC_ABORT_AFTER_SKIPS` | `300` | gallery-dl's `-A` budget |
| `INSTAGRAM_SYNC_TIMEOUT_MINUTES` | `45` | hard cap on one run |
| `INSTAGRAM_SYNC_MIN_GALLERY_DL_VERSION` | `1.32.17` | version floor |
| `INSTAGRAM_SYNC_WORK_DIR` | `<galleryRoot>/.instagram-sync` | working set root |

## Working set

```
<galleryRoot>/.instagram-sync/
  cookies.txt      the live Instagram session (mode 0600)
  archive.sqlite   the download ledger (SQLite, despite the name it is a DB)
  gallery-dl/
    versions/<version>/gallery_dl/
    current -> versions/<version>
  staging/         (reserved; unused in the current direct-download design)
```

The working set lives **inside the gallery root** for two reasons:

- the gallery is a separate **btrfs mount** (`/dev/sdb`, 5.5 T); everything else
  under `DATA_ROOT` is on the small root filesystem, which was 100 % full on
  2026-10-19 and took Postgres down with it;
- the `.instagram-sync` segment is hidden, so Foldergram's scanner skips it
  (`isHiddenPath`, `server/src/utils/path-utils.ts:24`) and never tries to
  index the cookie or the archive.

## API

Mounted at `/api/plugins/instagram-sync`. All routes are authenticated.
Mutating routes require the `canManageLibrary` capability.

| method | path | purpose |
|---|---|---|
| `GET` | `/status` | plugin, gallery-dl, cookie, archive and last-run state |
| `POST` | `/run` | trigger a sync now (`409` if one is already running) |
| `POST` | `/cookie` | upload a fresh session cookie — **raw `text/plain` body** |
| `GET` | `/gallery-dl/check` | ask PyPI for the latest gallery-dl |
| `POST` | `/gallery-dl/update` | download, verify and activate a newer gallery-dl |

## Two things worth knowing

**`-A` is not a post cap.** gallery-dl's `-A N` means "abort after N
consecutive *skipped* files". It is the "you have caught up, stop early"
optimisation, and it only works while the archive and the on-disk library stay
authoritative.

**The archive does not have to be complete.** gallery-dl's `skip: true` also
skips files that already exist on disk, even when they are absent from the
archive. So a partially-complete ledger still produces an incremental sync —
the missing files are skipped by the filesystem check rather than re-downloaded.

## Cookie handling

The cookie is a **live Instagram session**. It expires on its own and cannot be
refreshed without a human logging in, which makes it the biggest operational
risk in this plugin.

- stored `0600`, never logged, never returned by a route, never in the DB;
- validated before every run — a missing or malformed cookie fails the run
  immediately instead of burning a sync cycle;
- refreshable from the Web UI without a server restart.

## Why gallery-dl is vendored

The server has Python 3.13 and `requests`, but no `pip` and no `ensurepip`.
`gallery_dl/` is 3.4 MB of pure Python with one dependency that is already
installed, so it ships as a plain directory and runs as
`python3 -m gallery_dl` with `PYTHONPATH` pointed at the active version.

The version floor is **1.32.17**: older versions resolve Instagram usernames
through `/web/search/topsearch/`, which Instagram has removed. Those versions
work for saved feeds but cannot resolve individual creator profiles.

## Deployment

The server runs from systemd, not Docker, and `CLAUDE.md`'s deploy steps copy
only `server/dist/` and `client/dist/`. **A new plugin has to be copied
explicitly:**

```bash
rsync -az --delete plugins/instagram-sync/dist/ \
  root@10.0.36.37:/opt/foldergram/plugins/instagram-sync/dist/
ssh root@10.0.36.37 "systemctl restart foldergram"
```

The first run also needs the cookie and the archive in place — see
`IMPLEMENTATION.md`, step 12.

### ⚠️ The gallery must be writable by the server

The gallery is a **shared** btrfs volume: `pvei` writes to it over NFS and
the server mounts the same storage at `/opt/foldergram-data/gallery`. The two
hosts see the same files with **different owners**, because they have
different uid mappings:

| Host | uid_map | Can write dirs owned by uid 0? | By uid 100000? |
|---|---|---|---|
| `pvei` (bare metal) | identity — root is host root | ✅ | ✅ |
| `10.0.36.37` (LXC) | `0 100000 65536` | ❌ (uid 0 is unmapped → `nobody`) | ✅ |

So any author directory created by `pvei`'s root is **unwritable** from the
server, and gallery-dl fails on it with `PermissionError … .mp4.part`.

The fix is to give the shared tree to the uid the server maps to its root:

```bash
# on the storage owner (pved1), once
cd /mnt/6T/offline/reels/gallery-dl/instagram
find . -maxdepth 1 -mindepth 1 -type d -uid 0 -print0 | xargs -0 -r chown -R 100000:100000
```

After that both hosts see the directories as owned by their own root, and the
server can write into every author folder. The plugin creates new directories
itself, so this only has to be re-run if `pvei`'s gallery-dl is used by hand
again.

`yt-dlp` is also worth installing on the server (`apt-get install -y yt-dlp`):
gallery-dl logs a fallback notice without it, and some Instagram CDN
variants are only reachable through the yt-dlp downloader.
