# instagram-sync

Scheduled Instagram → Foldergram sync. Replaces the `insta.sh` script that runs
`gallery-dl` by hand on `pvei`.

## What it does

1. Runs a vendored **gallery-dl** against an Instagram saved-posts feed.
2. Downloads land **directly in the gallery** — no staging directory, no move
   step.
3. The files that came down are handed to Foldergram's scanner so they appear
   in the library immediately.
4. A **poll** refreshes the library and the saved collections on an interval
   the user configures from the Web UI (the plugin owns its own timer).
5. **gallery-dl can update itself** from the Web UI: the plugin queries PyPI,
   verifies the download against the digest PyPI published, extracts it,
   smoke-tests it, and only then flips the active symlink.

## Polling

The schedule is first-class: it lives in `app_settings` and is edited from the
plugin's UI. There is one global configuration, because the plugin has a single
Instagram session (one cookie, one source feed) that the whole library shares.

| setting | default | meaning |
|---|---|---|
| `enabled` | `1` | poll at all |
| `intervalMinutes` | `240` (4 h) | time between two polls, 15 min – 7 days |
| `library` | `1` | refresh the general library (the saved-posts feed) |
| `collections` | `1` | refresh the saved collections |
| `collectionMode` | `all` | every saved collection, or only `collectionIds` |
| `collectionIds` / `collectionNames` | empty | the selected collections |

A poll runs the parts the configuration covers:

1. **the general library** — gallery-dl pulls the saved-posts feed and the
   scanner indexes whatever came down;
2. **the saved collections** — Instagram's named sub-collections are mirrored
   into library collections of the same name.

Both halves are reported separately: a poll that refreshed the library but
could not reach Instagram's collections is not a total failure.

The schedule is anchored on the **last poll**, not on the boot time, so a
server that restarts often still polls. A poll that came due while the server
was down runs at the next tick.

A poll never overlaps another one: a poll in progress blocks the next tick, a
manual sync does not start while a poll is running, and a tick is skipped
while the scanner is busy so a poll does not queue behind a large library
scan.

## Configuration

Everything the plugin needs from the environment. The plugin's own settings
(what a poll covers, how often it runs) are in the database — see
[Polling](#polling).

All optional; the defaults match the shell script this replaces.

| env | default | meaning |
|---|---|---|
| `INSTAGRAM_SYNC_ENABLED` | `1` | `0` disables the plugin entirely |
| `INSTAGRAM_SYNC_SOURCE_URL` | `https://www.instagram.com/rodantes_6/saved/` | the saved-posts feed |
| `INSTAGRAM_SYNC_ABORT_AFTER_SKIPS` | `30` | gallery-dl's `-A` budget for the saved-posts feed |
| `INSTAGRAM_SYNC_ABORT_AFTER_SKIPS_COLLECTIONS` | `10` | the same budget for one collection |
| `INSTAGRAM_SYNC_ABORT_AFTER_SKIPS_DEEP` | `3000` | the budget of an intensive scan |
| `INSTAGRAM_SYNC_TIMEOUT_MINUTES` | `45` | hard cap on one run |
| `INSTAGRAM_SYNC_MIN_GALLERY_DL_VERSION` | `1.32.17` | version floor |
| `INSTAGRAM_SYNC_WORK_DIR` | `<galleryRoot>/.instagram-sync` | working set root |

## How far a poll looks

gallery-dl's `-A N` is not a post cap. It is an **early-exit**: the extractor
stops after `N` files in a row were skipped, because the list is ordered
newest first and the new posts are reached before any skip. The budget is
how far down the list a poll looks before it decides that it is caught up.

| scope | budget | why |
|---|---|---|
| the saved-posts feed | 30 | the feed is huge; a big budget only walks a long way down the list of things it already has |
| one collection | 10 | a collection is enumerated on its own, and the early-exit is what makes the poll fast |
| an intensive scan | 3000 (feed) / none (collections) | used when the last run did not go well |

The collections consult the **download archive** while they are listed, which
is what lets their budget fire at all. Without it, every poll enumerates
every media of every collection again — minutes per collection.

### The false "finished"

gallery-dl swallows the early-exit and exits `0`, so a run that gave up half
way looks exactly like a run that finished. The plugin counts the run of
skips in the output — the budget counts *consecutive* skips and a download
resets the run — and reports `stoppedEarly`. The collections say the same
thing: a listing that gave up reports a **partial** collection.

### The deep pass

One collection per job is enumerated **whole** and fetched. That is the pass
that catches the media the early-exit walks past:

- a collection is ordered by the date of the **post**, not by the day it was
  saved — so a post saved yesterday but posted in 2023 sits deep in the list,
  where the early-exit never looks;
- the general sync walks the saved-posts feed and stops after thirty
  already-downloaded posts, so a post whose download failed once is never
  reached again — it is stranded behind the window.

The deep pass runs **without the download archive**: the ledger is a claim,
not a fact, and it still claims the media whose files are gone. The on-disk
check is the truth — what is not on disk is fetched, what is on disk is left
alone.

The pass goes where the work is: a collection that had media missing last
time is the one enumerated whole.

### The intensive scan

When a run did not go well, the plugin asks for an **intensive** scan: the
next one walks much further before it decides that it is caught up. The
request is remembered, so it survives a restart, and it says why:

- a library run that failed, errored or could not use the ledger;
- a collection holds media the library does not **while the library run
  caught up** — then the ledger may be claiming media that are not really
  there, and the next library scan looks further (and without the ledger, so
  a file the ledger claims but that is gone is fetched again).

Two rules keep it from becoming a permanent state, because a poll that always
runs intensively is slower than the fault it was meant to cure:

- the request is **consumed** by the run that uses it;
- a fault asks for a scan only when it is **new** — a fault that was already
  there when the intensive scan ran has had its remedy.

### How long a poll takes

Measured on the production server, 42 collections and a 3714-post library:

| phase | time | why |
|---|---|---|
| the saved-posts feed | ~25 s | the downloads themselves |
| one collection | ~2 s | Instagram's own round trip for the first page |
| all the collections | ~2 min | 42 × 2 s, one after the other |

The collections are listed one at a time on purpose: Instagram's API is the
slow part, and asking it for several collections at once is what earns a
rate limit. The listing stops after ten already-downloaded media, so it is
one round trip per collection rather than a walk through the whole thing.

The intensive scan is the outlier: without the early-exit, one collection can
take minutes, and a poll of 42 of them takes hours. That is why the request
is bounded.

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
| `POST` | `/run` | trigger a library sync now (`409` if one is already running) |
| `POST` | `/cookie` | upload a fresh session cookie — **raw `text/plain` body** |
| `GET` | `/gallery-dl/check` | ask PyPI for the latest gallery-dl |
| `POST` | `/gallery-dl/update` | download, verify and activate a newer gallery-dl |
| `GET` | `/collections` | the user's Instagram saved collections |
| `POST` | `/collections/sync[?name=…]` | mirror them into library collections |
| `GET` | `/poll` | the polling configuration, the next poll and the last one |
| `POST` | `/poll` | change the polling configuration |
| `POST` | `/poll/run` | trigger a poll now (`409` if one is already running) |

`POST /poll` takes a partial configuration — the fields it does not carry are
left alone:

```json
{
  "enabled": true,
  "intervalMinutes": 240,
  "library": true,
  "collections": true,
  "collectionMode": "selected",
  "collectionIds": ["18108037513940688"],
  "collectionNames": ["repo"]
}
```

An interval outside the supported range is rejected with a `400` rather than
silently clamped.

## Saved collections → library collections

Instagram keeps saved posts in named sub-collections (`/saved/<name>/<id>/`).
The plugin mirrors them into library collections of the same name.

1. **Listing the collections** needs Instagram's GraphQL query
   `PolarisProfileSavedTabContentQuery`, which gallery-dl has no extractor for.
   A small Python helper (`python/list_collections.py`) drives it through
   gallery-dl's own machinery — cookie handling, `lsd`/`fb_dtsg` extraction,
   request signing — so it stays in step with the vendored version. The
   query's `doc_id` is a constant fallback: gallery-dl normally discovers it by
   scanning Instagram's JS, but this query lives in a lazily-loaded chunk, so
   discovery raises. If Instagram rotates the id the helper fails with a clear
   message and the constant has to be updated.
2. **A collection's media** is listed with gallery-dl's own collection
   extractor and `--no-download`: it enumerates the media and prints the paths
   it *would* download, without fetching anything. The archive is not consulted
   at all, so the already-downloaded files are simply listed.
3. **The mapping is exact**: gallery-dl lays media out as
   `<author>/<media_id>.<ext>`, which is precisely the library's
   `images.relative_path`. No translation is needed.
4. The media go into a library collection of the same name — an existing one is
   reused, otherwise it is created.
5. Media that is on disk but not indexed yet are indexed first (the startup
   scan is skipped when the library already has folders), so the mirror is
   self-healing.

The mirror reports what it did: how many media the collection holds, how many
matched, and the relative paths of the ones that are not in the library yet.

Mirroring one collection takes a couple of minutes — most of it is Instagram
enumerating the collection's media, not the copy.

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
