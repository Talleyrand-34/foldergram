---
title: Features
description: Verified product features and UI behaviors in the current Foldergram app.
---

# Features

This page documents what the current repository actually implements.

## Home

The home view is the primary feed surface.

It includes:

- three feed modes: Recent, Rediscover, and Random
- a top Moments or Highlights section
- feed-card avatar rings that can open an App Folder's avatar story in place when that folder has stories
- an active home-feed video player that promotes one visible video card at a time and gives that card play, mute, fullscreen, and seek controls
- feed-card actions for downloading the original media file and opening the original in a new tab
- bookmark actions that can save a post directly or manage its collection membership from a popover
- place links on feed-style cards when a photo has an assigned location
- scan progress states that distinguish discovery from later media-processing work while the library is being prepared
- a rebuild notice when the configured gallery root changed
- desktop recommendations for folders based on recency, likes, and recent navigation
- infinite loading for feed pagination

### Feed mode behavior

| Mode | What it does |
| --- | --- |
| Recent | "Newest posts first, with lighter runs from the same app folder." |
| Rediscover | "Older posts resurface when they are worth another look." |
| Random | "A fresh shuffle that stays steady while you browse." |

## Reels

The dedicated reels view is available at `/reels`.

It includes:

- a video-only queue sourced from indexed library posts
- a full-height scroll-snap deck
- wheel, arrow-key, and page-up/page-down navigation in addition to direct scrolling
- infinite loading with prefetch as you approach the end of the current queue
- an action rail with like/favorite toggle, save-to-collection bookmark, details sidebar, folder shortcut, and original-video link (visible on both mobile and desktop)
- a playback speed selector cycling x1 → x2 → x3 → x1, persisted across reel navigation
  - on desktop: button below the prev/next navigation arrows
  - on mobile: button above the like button in the action rail
- a bottom-edge seekable progress UI shared with the feed and post players
- loading, empty, and error states
- an app-wide default mode from Settings; the page itself does not expose an inline mode switch

### Reels keyboard shortcuts

| Key | Action |
| --- | --- |
| `↑` | Previous reel |
| `↓` | Next reel |
| `Space` | Play / pause |
| `=` | Cycle playback speed (x1 → x2 → x3 → x1) |

### Queue behavior

| Mode | What it does |
| --- | --- |
| Recommended | "Affinity-ranked mix." It scores videos using freshness, likes, recent folder affinity, portrait fit, duration fit, and a deterministic seed, then reduces immediate repeats from the same folder when alternatives exist. |
| Recent | "Newest videos first." |
| Random | "Stable session shuffle." |

## Explore

Explore is a dedicated full-screen shell with a darker visual treatment.

It combines:

- a random feed source
- client-side ranking that boosts recent folder activity, liked folders, and recently opened folders
- folder search across name, slug, breadcrumb, and path
- local recent-search history stored in `localStorage`

Explore is a folder-search and serendipity surface, not a separate backend index.

## Library

Library lists every indexed folder and supports:

- fuzzy search — characters must appear in order; consecutive runs of matching characters score higher; results are ranked by match quality when a query is active
- sorting by recent activity, post count, name, or path
- quick navigation into folders
- delete actions from a context menu
- infinite scroll pagination
- header totals (folder count and post count) sourced from server-stored stats, not the current page

### Folder deletion behavior

Library supports two delete flows:

| Flow | Behavior |
| --- | --- |
| Delete app folder | Deletes the folder's direct posts and their derivatives. Child app folders are kept. The source folder is only removed if it becomes empty. |
| Delete folder subtree | Removes the source folder subtree from disk, removes matching derivative subtrees, and deletes all affected indexed folders below that path. |

## Folder pages

A folder page is available at:

- `/f/:slug`
- `/folders/:slug` as a legacy alias

Folder pages include:

- a folder header with avatar, posts counts, descriptions, and optional avatar-story opening
- editable folder name and description via an admin "Edit App Folder" flow
- long descriptions that collapse to two lines by default and expose an expand/collapse caret only when the text actually overflows
- a posts grid that follows the app-wide default folder order
- highlight circles above the posts and reels tabs when the folder has story capsules
- a reels tab when the folder contains videos
- infinite loading

The reels tab is a filtered view backed by the same folder endpoint using
`mediaType=video`.

The post viewer also uses the same default folder order when resolving previous
and next navigation within a folder.

## Folder stories and highlights

Foldergram can reserve `AppFolder/stories` as a story-style source for that
folder.

In the default reserved-stories mode:

- direct media inside `AppFolder/stories` becomes the folder's avatar story set
- each direct child folder inside `AppFolder/stories` becomes one highlight capsule
- nested folders below a highlight are folded into that same capsule instead of becoming separate app folders
- story media is hidden from normal folder, feed, search, and reels surfaces
- the folder header avatar opens the avatar story when one exists
- Home feed cards can open the same avatar story from the folder avatar ring
- the shared stories modal is used for both the home-feed entry point and the folder-page entry points
- the shared stories modal header includes original-media download plus playback controls for the active story item

If the reserved root has no direct media but highlight capsules do exist,
Foldergram can synthesize the avatar story from recent highlight media so the
folder still has an avatar-story entry point.

## Places

Places add an offline location layer for photos that already contain GPS
metadata.

The current app includes:

- a dedicated `/places` directory page
- search and sort controls for place name, country, and post counts
- `/places/:slug` detail pages with grouped posts
- approximate-city labeling when the stored match is not exact
- location links on feed-style cards and inside post-viewer metadata
- a Places shortcut in navigation when indexed places exist
- Settings controls to prepare offline GeoNames data and rebuild place assignments

## Post detail and modal flow

The canonical post detail route is `/post/:id`.

`/image/:id` remains available as a legacy alias.

Behavior depends on how the route is opened:

- from another page, it can render as a modal over the background route
- directly, it renders as a full page

The detail view includes:

- image detail media sourced from either generated previews or originals, depending on `IMAGE_DETAIL_SOURCE`
- video detail playback that defaults to the generated preview source
- an optional `HD` toggle for compatible higher-resolution MP4 originals
- previous and next navigation within the same folder and active media filter
- folder link and breadcrumb context
- caption text that uses a saved custom caption when present and otherwise falls back to a readable filename
- an admin-only inline caption edit action in the sidebar summary, with the same caption reflected across feed-style surfaces
- size, dimensions, MIME type, duration, and location metadata when available
- like toggle
- save and collection controls
- original-media download control
- a share control that hands the **file itself** to the operating system share sheet, when the browser supports it
- original-file link
- an admin-only "Set as Cover" action to customize the folder avatar, which highlights dynamically if the image is already the cover
- trash and permanent-delete actions with confirmation for admin sessions only

### Post viewer keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` or `↑` | Previous post |
| `→` or `↓` | Next post |
| `Space` | Play / pause (videos) |
| `=` | Cycle playback speed — x1 → x2 → x3 → x1 (videos) |

### Sharing a media file

The share control hands the **original file** to the operating system share
sheet, so the receiving app gets the media itself - a photo app receives the
photo, a messaging app attaches the video. It is available in the reels rail
and in the actions row of the post viewer.

The browser decides what can be shared, and the rules are its own:

- the API only exists in a **secure context**, so the control is not rendered
  at all on a plain-HTTP origin. The LAN test instances need the HTTPS
  deployment, or a reverse proxy in front of them.
- the whole payload of one share may not exceed **50 MiB**. A bigger file is
  not fetched: the control reports that it is too large, and the download
  control next to it remains the way to get the file.
- only a fixed list of file types is accepted. `.mov` and `.mkv` originals can
  never be shared as files from a browser, so the control is not rendered for
  them; the file is never renamed to fake a permitted container.

The share sheet only opens inside a live user gesture, and that gesture lives
for five seconds. The control therefore has two states: the first tap fetches
the file, and the second one opens the sheet. When the file is small and fast
enough, the sheet opens on the first tap.

The research behind these limits, with the sources, is in
`docs/plans/share-media-as-file.md`.

## Saved posts, likes, and collections

Foldergram has two saved-items storage modes:

- signed-in `admin` and `viewer` sessions use shared SQLite likes and collections
- anonymous public sessions use browser-local favorites and collections stored in `localStorage`

Collections include:

- a default saved collection surfaced as `All Posts` in the UI
- custom collections with create, rename, and delete flows
- bookmark-popover collection membership management from feed cards and the post viewer
- dedicated `/collections` and `/collections/:slug` routes
- syncing between the default saved state and custom collection membership

Likes remain separate from saved posts.

The likes view:

- shows liked or favorited posts ordered by the most recent toggle in that mode
- updates optimistically in the UI
- drops deleted or trashed posts automatically when they are removed
- stays intentionally separate from saved-post collections

There is no shared social layer behind any of these surfaces.

## Trash

Trash is an admin-only recovery surface at `/trash`.

It includes:

- paginated deleted-post cards
- multi-select restore actions
- multi-select permanent-delete actions
- folder shortcuts for reviewing where a trashed post came from
- an empty state when nothing is currently trashed

Moving a post to Trash keeps the original file on disk. Permanent delete removes
the original file, thumbnail, and preview.

## Moments

Home and `/moments/:id` expose either:

- date-driven Moments
- fallback Highlights

The selected set depends on timestamp coverage in the current library. The UI
uses the same route name for both and adapts to the returned payload labels.

This is separate from folder stories and folder highlights sourced
from reserved `stories/` folders.

## Settings

Settings is the operational control surface for the library.

Its left sidebar is split into:

| Section | What it contains |
| --- | --- |
| `Scan & Library` | Phase-aware live scan state, manual scan, thumbnail-only rebuild, and library-index rebuild actions. Admins also see the full report path when a scan finishes with skipped media errors. |
| `General Settings` | App-language selection with instant local switching plus saved app-wide defaults, Home and Reels default feed modes, the default App Folder photo order, nested folder title format, stories-folders mode, excluded-folder rules, migration notices, and save-and-rescan prompts for those app-wide changes. |
| `Places` | Offline GeoNames preparation status plus place-assignment rebuild actions for GPS-tagged photos. |
| `Security & Access` | Admin password, viewer password, public mode, sign-out, and related auth controls. |
| `System Status` | Storage and index state plus last completed scan details, including whether the last run completed with errors. |

In `General Settings`, the language selector applies immediately in the current
browser. That browser-local override is stored locally, and clicking `Save
changes` also stores the selected language as the app-wide default for browsers
without their own override. That saved default also reaches the login gate and
other pre-auth translated UI on devices that are using the app-wide language.
Nested folder title format changes are presentation-only and update without a
rescan. Env-backed excluded-folder rules are shown read-only and custom rules
are saved at runtime. Changing stories mode or excluded folders still requires
a follow-up scan from `Scan & Library`.

On mobile, Settings uses a dedicated sticky top icon bar instead of the desktop
sidebar.

The live scan state stays open-ended during discovery and becomes determinate
when later media-processing work has a known total.

### Access protection

Settings can optionally enable role-based local access for the app.

That flow supports:

- turning the admin password on
- changing the admin password
- disabling protection again
- enabling or disabling a separate viewer password
- enabling anonymous public browse mode
- rotating the viewer password without knowing the current one
- signing the current browser session out

Current non-admin behavior:

- viewers can browse the library and use shared likes and collections
- anonymous public visitors can browse immediately and use browser-local favorites and collections
- `viewer` and `anonymous` sessions can elevate through `Unlock admin`
- non-admin sessions cannot open Settings
- non-admin sessions cannot use Trash, delete actions, scans, or rebuild actions

### Rebuild actions

| Action | What changes |
| --- | --- |
| Scan Library | Runs a normal scan against the current gallery root. In `SCAN_MEDIA_ERROR_MODE=skip`, supported-media failures are reported, skipped, and the run finishes as `completed_with_errors`. |
| Regenerate Thumbnails | Clears generated thumbnails and video poster images, then rebuilds them from indexed media only. |
| Rebuild Library Index | Clears indexed folders, posts, likes, folder scan state, and scan history, then rescans the active gallery root and reuses matching cached derivatives when possible. In lazy derivative mode it does not pre-generate missing thumbnails or previews. |

## Telemetry for the AI resources

The application reports how it consumes the AI resources as OpenTelemetry
metrics and traces, so the numbers can be read with the tools the operator
already has - an OpenTelemetry Collector, Prometheus, Grafana or a hosted
backend - instead of a chart inside the application.

Nothing leaves the machine unless telemetry is configured. With no exporter
the cost is a function call.

What is reported:

- how many analyses ran, with which provider and model, and how they ended
- how long an analysis takes, and how that time splits between the frames,
  the transcription and the model call
- how many tokens were spent, input and output, which is the number that
  decides the budget
- which failures happen and how often
- how much work is waiting in the queue, and why the queue stopped
- how long the database takes, per operation and per table, and how long the
  API takes, per route

The configuration is the standard OpenTelemetry one, so an existing Collector
setup works unchanged:

```bash
TELEMETRY_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
OTEL_SERVICE_NAME=foldergram
```

The metric names, their labels and the available variables are listed in
[Configuration](configuration.md#telemetry-opentelemetry).

The full guide - the architecture, the exact Prometheus series names, the
PromQL queries, and how to connect a Collector, Prometheus or Grafana - is in
[Telemetry](telemetry.md).

## Profiling

The application can also push continuous profiles of the Node.js process to a
Pyroscope server, which Grafana reads as a flame graph. The metrics say how
long; the flame graph says where the time goes.

Nothing leaves the machine unless a Pyroscope address is configured:

```bash
PYROSCOPE_SERVER_ADDRESS=http://pyroscope:4040
PYROSCOPE_APPLICATION_NAME=foldergram
```

The `wall` profile is the interesting one for the database: the time spent
waiting for PostgreSQL appears in the graph as the frames of the driver and
of the socket, with the width of the wait.

The full guide - the profile types, how to read the flame graphs and how to
connect Grafana - is in [Telemetry](telemetry.md#profiling).

## Theme, language, and local UI preferences

The client also persists a few local browser preferences:

- selected language override
- light or dark theme
- whether videos start muted
- last opened folder
- recently opened folders
- recent explore searches

These are stored in `localStorage`.

The selected language also has one extra layer:

- changing the language updates the current browser immediately
- saving `General Settings` stores that language in the app database as the default for browsers without a local override

## What is intentionally missing

The current repository does **not** implement:

- uploads from the UI
- comments
- messaging
- notifications
- multi-user accounts
- remote multi-user permissions
- cloud sync
- hierarchical album navigation
