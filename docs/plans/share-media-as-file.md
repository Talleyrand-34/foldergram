# Plan: "Share as file" (Web Share API Level 2)

**Status:** research + plan only. No implementation.
**All platform claims checked on 2026-11-02** (see [S1]–[S16] for exact URLs).
**Repo facts** in this document were read directly from the working tree at `/home/asada/Documents/test/foldergram` (paths + line numbers cited inline).

---

## 1. Verdict

**Yes, with caveats — viable on Android Chrome today, and the app already satisfies the PWA precondition.**

`navigator.share({ files: [File] })` is supported in Android Chrome from **v76** [S1][S3], in a plain browser tab as well as an installed PWA [S8][S12], and Foldergram **already ships a web app manifest with `display: "standalone"` and a registered service worker** (`client/public/manifest.webmanifest`, `client/public/sw.js`, `client/src/main.ts:88-93`), so **no PWA-ification work is required**. The feature is ~1 new client component plus a thin fetch helper; the server needs **no changes at all** for the happy path.

**The single biggest caveat is a hard 50 MiB / 10-file browser limit that the page cannot negotiate:** Chromium rejects a share whose total payload exceeds `50 * 1024 * 1024` bytes (52,428,800 bytes) with `NotAllowedError` *before* the OS share sheet ever opens [S5][S6]. Foldergram's library explicitly holds large videos (the task brief calls out "hundreds of MB"), so a large fraction of reels will simply not be shareable as files. Second-biggest caveat, and the one that shapes the UI: **the share call must happen inside a live user gesture, and Chromium's transient activation window is 5 seconds** [S7][S9][S10] — so you cannot "download the file, then share it" for anything that takes longer than a few seconds to transfer.

Two more concrete Android-specific facts that shape the design:

- **Chrome only accepts a fixed allowlist of extensions/MIME types.** `.mov` and `.mkv` — both of which Foldergram indexes and serves (`server/src/utils/image-utils.ts:50-73` maps them to `video/quicktime` / `video/x-matroska`) — are **not** in Chromium's `PERMITTED_EXTENSIONS` or `PERMITTED_MIME_TYPES`, so those files can never be shared as files from a web page on Android, no matter how the client labels them [S6].
- **iOS Safari does support file sharing** (Safari / iOS Safari 14+) [S1], so the feature is not Android-only — but its file-type allowlist is narrower and its activation rules are stricter [S11][S14].

---

## 2. Platform support table

Sources are MDN browser-compat-data (`api/Navigator.json`, `api/UserActivation.json`) [S1][S2] unless stated otherwise. "Files" = the `ShareData.files` member (`api.Navigator.share.data_files_parameter`).

| Platform | `navigator.share()` (url/text) | `navigator.share({files})` | `navigator.canShare({files})` | Verdict for this feature | Source (checked 2026-11-02) |
|---|---|---|---|---|---|
| **Android Chrome — normal tab** | ✅ 61+ | ✅ **76+** | ✅ 75+ | **Fully supported.** No install required. | [S1] `chrome_android: share 61, data_files_parameter 76, canShare 75`; [S8][S12] for "no install needed to *send*" |
| **Android Chrome — installed PWA (standalone)** | ✅ 61+ | ✅ 76+ | ✅ 75+ | **Fully supported.** Same code path; the SW is irrelevant to `share()`. | [S1]; install affects *receiving*, not sending [S12] |
| **Android WebView (all versions)** | ❌ `false` | ❌ `false` | ❌ `false` | **Not supported.** | [S1] `webview_android: version_added: false`, `impl_url: crbug.com/40540400` |
| **iOS Safari / Safari on iOS** | ✅ 12.2+ | ✅ **14+** | ✅ 14+ | **Supported**, but the file-type allowlist is narrower and activation is stricter. | [S1] `safari: 12.1 / data_files_parameter 14`; `safari_ios: mirror` |
| **Desktop Chrome (Windows/ChromeOS)** | ✅ 89+ (128+ on macOS/Linux) | ✅ 89+ | ✅ 89+ (128+ on macOS/Linux) | **Supported** on Windows/ChromeOS since 89, cross-platform since 128. | [S1] `chrome: 89 partial (ChromeOS+Windows only) → 128 full`; [S3] |
| **Desktop Edge (Windows)** | ✅ 93+ | ✅ 81+ | ✅ 93+ | Supported on Windows. | [S1] |
| **Desktop Firefox** | ⚠️ 71+ but **flag-gated** (`dom.webshare.enabled`) | ❌ `false` | ⚠️ 96+ flag-gated | **File sharing not supported at all.** | [S1] `firefox: data_files_parameter → false` |
| **Firefox for Android** | ✅ (caniuse: 159+ supported) | ❌ `false` | ⚠️ 96+ flag-gated | **`navigator.share` exists for text/URL, but file sharing is `false`.** | [S1] `firefox_android: mirror → false` for files; [S3] caniuse Firefox-for-Android 159 |
| **Samsung Internet (Android)** | ✅ 8.2+ | ✅ 11.0+ | ✅ mirror of Chrome | Supported. | [S1] `samsunginternet_android: data_files_parameter 11.0` |
| **Opera / Opera Android** | ✅ 48+ (Android) | ✅ mirror of Chrome | ✅ mirror of Chrome | Supported. | [S1] |

### Supporting facts

- **[VERIFIED]** The API is `[SecureContext]` — it only exists over HTTPS (or `http://localhost`) [S4][S11]. `navigator.share` is `undefined` on a plain-HTTP LAN origin.
- **[VERIFIED]** A third-party iframe needs `allow="web-share"`; Foldergram is first-party, so this does not apply [S11].
- **[VERIFIED]** `navigator.userActivation.isActive` is available to implement the "is the gesture still alive?" check: Chrome/Chrome Android 72+, Safari/iOS 16.4+, Firefox 120+ [S2].
- **[VERIFIED]** The spec explicitly leaves payload interpretation to the receiving app: "the meaning of the payload is at the discretion of the share target" [S4]. In practice some apps (notably iOS Messages in the W3C issue tracker) drop the file and keep the text/URL, and vice-versa [S13].

### Not verified by me

- **[NOT VERIFIED]** I did not test on a physical Android device or a real iPhone. All platform claims above are documentation/source readings, not runtime observations.
- **[NOT VERIFIED]** The exact construction of the Android `Intent` that carries the file (the `EXTRA_STREAM` / `FLAG_GRANT_READ_URI_PERMISSION` code) lives in a Chromium file I did not locate in the current tree (it moved out of `chrome/android/java/src/org/chromium/chrome/browser/share/ShareHelper.java`). What *is* verified: `ShareHelper.getShareFileAppCompatibilityIntent()` sets `intent.setType(fileContentType)` on an `Intent.ACTION_SEND` [S16], and Android's documented contract for passing binary content is `ACTION_SEND` + `EXTRA_STREAM` + `type` + a temporary read grant on the content URI [S14][S15].

---

## 3. Hard limits (numbers)

### 3.1 Size and count — the dominant constraint

| Limit | Value | Enforced by | Failure mode |
|---|---|---|---|
| Max total bytes in one `share()` call | **52,428,800 bytes (50 MiB)** | Blink renderer, `kMaxSharedFileBytes = 50U * 1024 * 1024` [S5]; re-checked browser-side as `MAX_SHARED_FILE_BYTES = 50 * 1024 * 1024` [S6] | Console warning `"Share too large"` + `DOMException` `NotAllowedError` ("Permission denied"). **The share sheet never opens.** |
| Max files per call | **10** | `kMaxSharedFileCount = 10` [S5]; `MAX_SHARED_FILE_COUNT = 10` [S6] | Same as above. Irrelevant for Foldergram (1 file). |
| Max `title` length | 16,384 chars | `kMaxTitleLength = 16U * 1024` [S5] | `NotAllowedError`. |
| Max `text` length | **122,880 chars on Android** (1,048,576 elsewhere) | `kMaxTextLength = 120U * 1024` under `#if defined(OS_ANDROID)` [S5] | `NotAllowedError`. |
| Max `url` length | 16,384 chars | `kMaxUrlLength = 16U * 1024` [S5] | `NotAllowedError`. |

**There is no size limit in the Android OS share sheet itself** for a `content://` URI — the payload is passed by reference, not through Binder, so `TransactionTooLargeException` does not apply [S15]. The 50 MiB ceiling is entirely Chromium's.

### 3.2 File type allowlist (Chromium on Android)

From `PERMITTED_EXTENSIONS` / `PERMITTED_MIME_TYPES` in `components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/ShareServiceImpl.java` [S6]:

- **Permitted extensions (42):** `avif, bmp, css, csv, ehtml, flac, gif, htm, html, ico, jfif, jpeg, jpg, m4a, m4v, mp3, mp4, mpeg, mpg, oga, ogg, ogm, ogv, opus, pdf, pjp, pjpeg, png, shtm, shtml, svg, svgz, text, tif, tiff, txt, wav, weba, webm, webp, xbm`
- **Permitted MIME types (29):** `audio/flac, application/pdf, audio/mp3, audio/mpeg, audio/ogg, audio/wav, audio/webm, audio/x-m4a, image/avif, image/bmp, image/gif, image/jpeg, image/png, image/svg+xml, image/tiff, image/webp, image/x-icon, image/x-ms-bmp, image/x-xbitmap, text/comma-separated-values, text/css, text/csv, text/html, text/plain, video/mp4, video/mpeg, video/ogg, video/webm`

Both checks must pass. The MIME check is against **the `type` you put on the JS `File` object** (`blob.contentType`), which the page controls; the extension check is against **the filename** you put on the `File`.

**Impact on Foldergram** (`server/src/utils/image-utils.ts:50-73` is the server's own extension→MIME table):

| Foldergram extension | Server MIME | Extension permitted? | MIME permitted? | Shareable as a file? |
|---|---|---|---|---|
| `.jpg` / `.jpeg` | `image/jpeg` | ✅ | ✅ | **Yes** |
| `.png` | `image/png` | ✅ | ✅ | **Yes** |
| `.webp` | `image/webp` | ✅ | ✅ | **Yes** |
| `.gif` | `image/gif` | ✅ | ✅ | **Yes** |
| `.avif` | `image/avif` | ✅ | ✅ | **Yes** |
| `.mp4` | `video/mp4` | ✅ | ✅ | **Yes** |
| `.webm` | `video/webm` | ✅ | ✅ | **Yes** |
| `.m4v` | `video/x-m4v` | ✅ (`m4v`) | ❌ | **Only if the client labels it `video/mp4`** — see Open Question 4. |
| `.mov` | `video/quicktime` | ❌ (`mov`) | ❌ | **Never shareable as a file.** |
| `.mkv` | `video/x-matroska` | ❌ (`mkv`) | ❌ | **Never shareable as a file.** |

### 3.3 Filename rules (Chromium `isDangerousFilename`) [S6]

A shared filename is rejected unless **all** hold:

1. Non-empty.
2. Contains no `..` and is not `.`.
3. Contains no `/` and no `\` → **must be a bare basename**, not a path.
4. Has no leading/trailing whitespace and does not end with `.`.
5. Has an extension present in `PERMITTED_EXTENSIONS`.

Foldergram's `images.filename` is already a bare basename — the scanner stores `filename: path.basename(file.absolutePath)` (`server/src/services/scanner-service.ts:2584, 2672, 2697`) — so rule 3 is satisfied by construction. Rules 2/4/5 are not guaranteed by the current data.

### 3.4 User-gesture requirement

| Rule | Value | Source |
|---|---|---|
| `share()` requires transient user activation | Yes — spec step 6, `NotAllowedError` if absent | [S4] |
| Chromium's error message | `NotAllowedError: Must be handling a user gesture to perform a share request.` | [S5] |
| Transient activation lifetime (Chromium production builds) | **5 seconds** (`kActivationLifespan = base::Seconds(5)`; the 60 s variant is `#if defined(MEMORY_SANITIZER)` only) | [S7] |
| `canShare()` needs no activation | Yes | [S4] |
| Second `share()` while one is pending | `InvalidStateError` | [S4] |

**Consequence:** an `await fetch(...)` inside the click handler races the 5-second window. For a 3 MB photo on Wi-Fi this is fine; for a 40 MB video on cellular it will reliably fail with `NotAllowedError`.

### 3.5 Android share-sheet mechanics

- **[VERIFIED]** Chromium writes each shared blob to a temp file under its shared-files directory and converts it to a `content://` URI via `FileProviderUtils.getContentUriFromFile(tempFile)`; those URIs are what the receiving app receives (`paramsBuilder.setFileUris(fileUris)`) [S6]. **The web page never sees the `content://` URI** — it only ever holds the `File`.
- **[VERIFIED]** The intent's MIME type is the file's own type: `SharedFileCollator.commonMimeType()` returns `type/subtype` for a single file, `type/*` for mixed subtypes of one type, `*/*` for mixed types [S6]; `ShareHelper` then does `intent.setType(fileContentType)` on an `Intent.ACTION_SEND` [S16].
- **[VERIFIED]** Android's intent resolution matches a receiver's `android:mimeType` against the intent type; the subtype may be the wildcard `*`, "to indicate that any subtype matches" [S17]. So an app registering `image/*` **will** receive an `image/jpeg` share, and an app registering `video/*` **will** receive a `video/mp4` share. The documented mapping table is explicit: receivers registering `image/*` accept senders sending `image/jpg`/`image/png`/`image/gif`; receivers registering `video/*` accept `video/mp4`/`video/3gp` [S14].
- **[VERIFIED]** MIME matching in the Android framework is **case-sensitive** — always use lowercase [S17].
- **[VERIFIED]** The content URI is only usable because the sender grants temporary read permission on it; that is the documented "only secure way" to hand a file to another app [S15].

### 3.6 Server-side limits of the current media route (verified by reading)

| Behaviour | Current state | Evidence |
|---|---|---|
| `Content-Type` on `/api/originals/:id` | Set from the file extension by the `send` module (`this.type(path)`), before the HEAD short-circuit | `node_modules/send/index.js:511` (`this.type(path)`) |
| `Content-Length` on `HEAD /api/originals/:id` | **Set to the real file size** — `send` sets `Content-Length` at line 581 and only then short-circuits HEAD at line 585 | `node_modules/send/index.js:581-588` |
| Range requests | Supported → `206 Partial Content` + `Content-Range` | `node_modules/send/index.js:496-570` |
| `Content-Disposition` filename | Only on the `?download=1` variant (`response.download(path, filename)`); the plain route sends no `Content-Disposition` | `server/src/routes/api.ts:1343-1359` |
| Auth | `/api` is behind `requireApiAuthentication`; read-only GET is allowed in public-viewer mode | `server/src/app.ts:57`; `server/src/middleware/auth-protection.ts` |
| Caching | `/api` responses get `Cache-Control: no-store`; `/thumbnails` and `/previews` get `private, max-age=604800, immutable` + `Vary: Cookie` | `server/src/app.ts:41-48`; `server/src/utils/media-response.ts` |
| Service worker | `client/public/sw.js` explicitly **bypasses** `/api/`, `/thumbnails/`, `/previews/`, `/originals/` and any request carrying a `Range` header → the share fetch is never served from the SW cache | `client/public/sw.js` (fetch handler) |

**Conclusion: the server needs no changes for the share-as-file path.** `GET /api/originals/:id` already returns the original bytes with a correct `Content-Type` and a correct `Content-Length` (discoverable via `HEAD`).

---

## 4. Proposed design

### 4.1 Where the button lives

Two surfaces, both of which already have a **download-original** affordance to sit next to:

1. **Reels** — `client/src/components/ReelActionRail.vue`. The rail already renders, in order: like button, `CollectionBookmark`, info toggle, **download `<a>`** (line 51-58), folder link. The share button goes **immediately after the download anchor**, reusing the same `.reel-action-rail__button` class and a Fluent icon (`i-fluent-share-16-regular`). The rail is rendered from `client/src/views/ReelsView.vue` in both the mobile (`#mobile-action-rail` slot) and desktop positions, so one edit covers both.
2. **Single post / photo** — `client/src/components/PostViewer.vue`, in the `.viewer__sidebar-actions` group at line 493+, immediately after the existing download `<a>` (line 513-518). `PostViewer` receives a full `ImageDetail`, so it has `mimeType` and `fileSize` for free.

Both surfaces get the **same** new component so the logic exists once.

### 4.2 New files (3)

```
client/src/components/ShareMediaButton.vue   # the button + all share logic
client/src/composables/useShareMedia.ts     # capability detection + fetch + share call
client/src/utils/share-media.ts             # extension/MIME allowlist + size cap constants
```

`useShareMedia.ts` owns the whole flow so `ShareMediaButton.vue` is a thin `<button>` with an icon, a busy state, and an error message.

### 4.3 The flow

```
click
 ├─ capability gate (evaluated on mount, re-evaluated per item)
 │    navigator.share && navigator.canShare && canShare({files:[probeFile]})
 │    → if false: the button is NOT RENDERED (see 4.5)
 ├─ HEAD /api/originals/:id
 │    → Content-Length, Content-Type
 │    → if size > 50 MiB          → show "too large" + offer link share
 │    → if extension/MIME not in Chromium's allowlist → offer link share
 ├─ GET /api/originals/:id  → response.blob() → new File([blob], filename, { type })
 └─ navigator.share({ files: [file], title: filename })
```

**The gesture problem.** The `HEAD` + `GET` cannot both complete inside Chromium's 5-second transient-activation window for a large file. The design therefore uses a **two-state button**:

- **State `idle`** — click starts the fetch. The button shows a spinner and the label "Preparing…". The `File` is memoised in a module-level `Map<number, File>` (bounded, e.g. keep the 3 most recent; a 50 MiB `File` in memory is a real cost, so cap it).
- **State `armed`** — the `File` is ready. The button now reads **"Tap to share"**. The next tap calls `navigator.share({ files: [file] })` **synchronously** with no `await` before it, so the gesture is fresh and unambiguous.
- **Fast path** — if the `File` was already in the memo cache when the user clicked, `navigator.share()` is called in the *same* handler with no intervening `await`. This is the common case for a user browsing reels: tap share twice and it opens immediately the second time.
- **Micro-optimisation** — after the `File` resolves, check `navigator.userActivation.isActive` [S2]; if the gesture is still alive (i.e. the fetch took < 5 s), call `navigator.share()` immediately instead of arming. This makes small photos open the sheet in one tap while large videos degrade gracefully to two taps.

### 4.4 Error handling

| `DOMException.name` | Meaning | UI |
|---|---|---|
| `AbortError` | User dismissed the share sheet, or no share target is installed | **Silent.** Not an error. |
| `NotAllowedError` | Gesture expired / policy / blocked file type | Show "Couldn't open the share sheet — tap Share again." and arm the button. |
| `TypeError` | Payload invalid, or this browser doesn't support file sharing | Hide the button; fall back to link share. |
| `DataError` | The target app failed to start or receive | Show an inline error message next to the button. |
| Fetch failure / 401 | Session expired or server error | Show "Couldn't load the file." — the app already has an `AUTH_REQUIRED_EVENT` mechanism (`client/src/api/http.ts`) for 401s. |

### 4.5 Degradation matrix

| Situation | Behaviour |
|---|---|
| `navigator.canShare` missing (Firefox desktop, Android WebView) | **Button not rendered.** |
| `canShare({files:[probe]})` false (type not shareable) | **Button not rendered** for that item; the existing download anchor remains. |
| File > 50 MiB | Button rendered but disabled-looking with a "File too large to share" tooltip, offering **link share** instead. |
| Extension/MIME outside Chromium's allowlist (`.mov`, `.mkv`) | Same as above: link share only. |
| `navigator.share` missing but `navigator.canShare` missing too | Nothing rendered. |
| Desktop Chrome on macOS/Linux < 128 | `canShare({files})` exists but the share is not implemented → rely on `canShare()` returning false. |

### 4.6 Fallback: link share

**[VERIFIED — repo]** The client currently has **no link-share affordance at all**: a grep across `client/src` for `navigator.share`, `navigator.canShare`, `clipboard`, `copyLink`, `shareUrl` returns **zero matches**. The only related affordances are the download anchor (`getOriginalMediaDownloadUrl`) and the "open original file" anchor.

So the plan introduces the fallback: when file sharing is impossible, the same button shares **the page URL** instead via `navigator.share({ url: window.location.href })` — supported on Android Chrome since 61, iOS Safari since 12.2, desktop Chrome since 89/128 [S1]. Label it "Copy link" / "Share link" rather than "Share file" so the two paths are distinguishable.

### 4.7 MIME type and filename selection

- **MIME**: prefer the `Content-Type` header of the `GET /api/originals/:id` response (set by `send` from the real file extension) — this is always the true type of the bytes being shared. Fall back to `ImageDetail.mimeType` (available in `PostViewer` but **not** in `FeedItem`, which is what `ReelActionRail` receives) and finally to a client-side extension map.
- **Filename**: `item.filename` (present on both `FeedItem` and `ImageDetail`; it is a bare basename). Sanitise it against Chromium's `isDangerousFilename` rules before use — strip any `/`, `\`, `..`, leading/trailing whitespace, and a trailing dot; if the sanitised name's extension is not in the allowlist, do not offer file sharing for that item.
- **Do not lie about the container.** Do not rename a `.mov` to `.mp4`. Fall back to link share.

---

## 5. Implementation steps (ordered)

Each step names real, verified paths. No server changes are required (see §3.6); steps 4-6 are the only optional server touches.

**Step 1 — Capability + allowlist constants.**
Create `client/src/utils/share-media.ts`:
- `SHARE_MAX_BYTES = 52_428_800` (50 MiB) — mirror of Chromium's `kMaxSharedFileBytes`.
- `SHARE_PERMITTED_EXTENSIONS: ReadonlySet<string>` — the 42 extensions from [S6].
- `SHARE_PERMITTED_MIME_TYPES: ReadonlySet<string>` — the 29 MIME types from [S6].
- `isShareableFileName(name: string): boolean` — implements Chromium's `isDangerousFilename` rules 1-5.
- `buildShareFileName(filename: string): string` — sanitises a Foldergram `filename` into a shareable basename.
- `canShareFiles(): boolean` — `typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function'`.
- `probeShareSupport(mimeType: string, name: string): boolean` — `navigator.canShare({ files: [new File([], name, { type: mimeType })] })`.

**Step 2 — The share composable.**
Create `client/src/composables/useShareMedia.ts`:
- `loadShareFile(id: number): Promise<File>` — `fetch(getOriginalMediaUrl(id), { credentials: 'same-origin' })` → `response.blob()` → `new File([blob], buildShareFileName(name), { type })`.
  - `getOriginalMediaUrl` already exists at `client/src/utils/original-media.ts:1-3` — **reuse it, do not add a second URL builder**.
  - Use `client/src/api/http.ts`'s conventions (`credentials: 'same-origin'`) but note `requestJson` is JSON-only — a new plain `fetch` is required here.
- `headShareFile(id: number): Promise<{ size: number; type: string }>` — `HEAD /api/originals/:id`, read `Content-Length` + `Content-Type`.
- `shareFile(file: File): Promise<'shared' | 'cancelled' | 'error'>` — wraps `navigator.share({ files: [file], title: file.name })` and maps the DOMException names per §4.4.
- `shareLink(url: string): Promise<'shared' | 'cancelled' | 'error'>` — the fallback.
- A small module-level `Map<number, File>` memo with a bounded size.

**Step 3 — The button component.**
Create `client/src/components/ShareMediaButton.vue`:
- Props: `item: FeedItem` (works for both `FeedItem` and `ImageDetail`, since `ImageDetail extends FeedItem` — `client/src/types/api.ts:333`), plus an optional `class` passthrough.
- Renders **nothing** when `canShareFiles()` is false or the item's extension is not shareable.
- Renders a `<button>` (not an `<a>`) with `i-fluent-share-16-regular`, `aria-label` and `title` from i18n, `aria-busy` while preparing.
- Emits no events; all state is local.

**Step 4 — Wire it into the reels rail.**
Edit `client/src/components/ReelActionRail.vue`: add `<ShareMediaButton :item="item" />` after the download anchor (currently lines 51-58). Import the component. The existing `ReelActionRail.test.ts` will need a `navigator.share`/`canShare` stub — jsdom has neither, so the button will simply not render; add one test that stubs them and asserts the button appears, and one that asserts it does not render without the stub.

**Step 5 — Wire it into the post viewer.**
Edit `client/src/components/PostViewer.vue`: add `<ShareMediaButton :item="image" />` into the `.viewer__sidebar-actions` group, after the download `<a>` (line 513-518). `PostViewer.test.ts` has an existing test at line 249 ("renders a download-original control beside the open-original action") — extend that pattern.

**Step 6 — (optional, recommended) expose `fileSize` to the rails.**
`FeedItem` (`client/src/types/api.ts:69-91`) has `filename` and `mediaType` but **not** `mimeType`/`fileSize`; the feed SQL projection (`server/src/db/repositories.ts:262-293`, `getFeedImageSelectSql`) selects `images.filename` but not `images.mime_type`/`images.file_size`, while the image-detail query (line 1833-1836) does select them. Adding `images.mime_type AS mimeType` and `images.file_size AS fileSize` to `getFeedImageSelectSql()` and to `listVisibleVideoCandidates()` (line 1325-1345), plus two fields on the client `FeedItem` type, would let the button decide *without* the `HEAD` round-trip.
**This is optional** — the `HEAD` request already yields size and type, and it works for every surface including `ReelsView` and `FeedCard`. Prefer the `HEAD`; add the SQL only if the extra round-trip proves annoying in practice.

**Step 7 — i18n.**
Add the new keys to **all three** locale files: `client/src/locales/en.json`, `client/src/locales/zh.json`, `client/src/locales/es.json`. `client/src/locales/validation.test.ts` asserts that every locale file has **exactly** the same leaf-path set as `en.json`, so a key added to one file and not the others fails the suite.
Suggested keys under a new `common.share.*` namespace (a new top-level namespace is fine — `validation.test.ts` only compares leaf paths, and `client/src/locales/index.ts` handles locale resolution):
`share.file`, `share.link`, `share.preparing`, `share.tapToShare`, `share.tooLarge`, `share.unsupportedType`, `share.failed`, `share.cancelled`.

**Step 8 — Tests.**
- `client/src/components/ShareMediaButton.test.ts` — new file, following the `@vue/test-utils` + jsdom pattern used by `ReelActionRail.test.ts`: stub `navigator.share`/`navigator.canShare`, assert the button is hidden without them, assert `navigator.share` is called with a `File` of the right name and type, assert `AbortError` is swallowed, assert `NotAllowedError` arms the button for a second tap.
- `client/src/utils/share-media.test.ts` — new file for the allowlist and filename sanitiser (pure functions, no DOM needed).

**Step 9 — Docs.**
Add a short section to `docs/features.md` describing the share behaviour and the 50 MiB / file-type limits, and mention the new locale keys. Note that `docs/.vitepress/config.ts` lists sidebar entries explicitly — `docs/plans/` is an internal plan folder and does **not** need a sidebar entry, but if the plan is meant to be public, add `plans/share-media-as-file` to `referenceItems`.

---

## 6. The PWA question, answered concretely

### 6.1 Is an installed PWA required to *send* a file?

**No.** This is the single most important PWA finding:

- **[VERIFIED]** MDN browser-compat-data lists `navigator.share({files})` for `chrome_android` as `version_added: "76"` with **no install-related caveat** [S1]. The API is a browser feature of Chrome Android, not of the installed-webapp runtime.
- **[VERIFIED]** The Chrome team's own Web Share demo states the install requirement in the *receiving* direction only: *"Before you can **receive** incoming media files via the Web Share Target API Level 2, you need to add the web app to your home screen."* [S12]. Nothing equivalent is said about sending.
- **[VERIFIED]** Chromium's Android implementation is a browser-level Mojo service (`ShareServiceImplementationFactory` registers `org.chromium.webshare.mojom.ShareService` for the browser process) [S6], available to any tab.

So **the "Share as file" button works in a normal Chrome tab on Android, with no install**.

### 6.2 Does Foldergram already qualify as a PWA?

**Yes, and that matters for two secondary reasons** (being installable is not required for `share()`, but it is what makes the app feel native and what makes `share()` feel native too):

| Requirement | Foldergram's state | Evidence |
|---|---|---|
| Web app manifest, served | ✅ `client/public/manifest.webmanifest`, linked from `client/index.html` (`<link rel="manifest" href="/manifest.webmanifest">`) | read from `client/index.html` |
| `display: "standalone"` | ✅ present | `client/public/manifest.webmanifest` |
| `start_url` / `scope` | ✅ `"/"` / `"/"` | same |
| Icons 192 + 512, incl. `purpose: "maskable"` | ✅ `icon-192.png`, `icon-512.png` | same |
| `theme_color` / `background_color` | ✅ `#4f46e5` / `#ffffff` | same |
| Service worker, registered in production | ✅ `client/public/sw.js`, registered at `client/src/main.ts:88-93` (`import.meta.env.PROD` only) | read from `client/src/main.ts` |
| `id`, `shortcuts`, `share_target`, `categories`, `screenshots`, `related_applications` | ❌ **absent** | `client/public/manifest.webmanifest` |
| HTTPS | ⚠️ **deployment-dependent** | see §6.3 |

Two manifest gaps worth closing *while we are here* (both optional for this feature):

- **`share_target`** — adding a `share_target` handler would let Foldergram **receive** shared photos/videos (Android only, and only once installed) [S12]. That is a separate feature; not required for sending.
- **`id`** — adding `"id": "/"` makes the install identity stable across releases. Cheap insurance.

### 6.3 The real deployment blocker: HTTPS

**[VERIFIED]** `navigator.share` and `navigator.canShare` are `[SecureContext]` [S4][S11]. The two internal test instances are plain-HTTP LAN addresses (`http://10.0.36.163`, `http://10.0.36.37` per `CLAUDE.md`), and a non-`localhost` HTTP origin is **not** a secure context. On those URLs `navigator.share` is `undefined` and the feature is simply absent.

**[VERIFIED]** `docs/deployment.md:185` already states: *"Foldergram does not handle TLS or virtual hosting itself. Put a reverse proxy in front for HTTPS"*, and the public demo is `https://foldergram.intentdeep.com/` (`docs/.vitepress/config.ts:49`). So the shipping deployment is fine.

**Action:** the share button must be gated on `window.isSecureContext` as well as on `navigator.share` existing, and the QA plan must be run against an **HTTPS** origin (the public demo domain, or a tunnel/proxy in front of the LAN instance).

### 6.4 Work required for the PWA itself

**None, for this feature.** The manifest and service worker already exist and are sufficient for `navigator.share({files})` to work in both a tab and an installed PWA. The optional polish (manifest `id`, `share_target` for *receiving*, `shortcuts`) is a separate, independent piece of work.

---

## 7. Risks and mitigations

| # | Risk | Tied to limit | Severity | Mitigation |
|---|---|---|---|---|
| R1 | A 60-300 MB reel is silently unshareable; `share()` throws `NotAllowedError` before the sheet opens. | §3.1 — 50 MiB cap [S5][S6] | **High** | Probe with `HEAD` and compare `Content-Length` against `SHARE_MAX_BYTES` *before* downloading. Above the cap: disable the file-share path and offer **link share** instead. Never attempt the fetch. |
| R2 | The `await fetch()` blows the 5-second transient-activation window on a slow connection, so `share()` fails with `NotAllowedError`. | §3.4 — 5 s activation [S7] | **High** | Two-state button (§4.3): once the `File` is in memory, the next tap calls `share()` synchronously with zero intervening `await`. Use `navigator.userActivation.isActive` [S2] to open the sheet in one tap when the fetch was fast. |
| R3 | A `.mov` or `.mkv` original can never be shared as a file on Android, but the user expects the button to work. | §3.2 — Chromium allowlist [S6] | Medium | Gate on the allowlist before rendering the file-share affordance; offer link share instead. Do not rename the file to fake a permitted container. |
| R4 | The shared filename is rejected by Chromium (`..`, `/`, trailing dot, bad extension). | §3.3 — filename rules [S6] | Medium | Sanitise through `buildShareFileName()` and re-check with `isShareableFileName()` before constructing the `File`. |
| R5 | Receiving apps drop the file (or the URL) and keep only the other half of the payload. | §3.5 / spec [S4][S13] | Medium | Send **only** `files` (plus `title`) for the file-share path, so an app that ignores the file has nothing else to show; do **not** mix `url` and `files` in the same call — the W3C issue tracker documents inconsistent handling of mixed payloads [S13]. |
| R6 | The feature is completely absent over plain HTTP (LAN instances). | §6.3 — `[SecureContext]` [S4][S11] | Medium | Gate on `window.isSecureContext`; document that the feature requires the HTTPS deployment; QA against `https://foldergram.intentdeep.com/` or a proxy. |
| R7 | Memory blow-up: a memoised 50 MiB `File` per item, several items deep. | §3.1 | Medium | Bound the memo to 2-3 entries; never cache anything above the size cap; drop the entry after a successful share. |
| R8 | The receiving app can't read the content URI (missing temporary grant, or a hostile/over-strict target). | §3.5 | Low | Out of the page's control — Chromium owns the grant. Surface `DataError` as an inline message and let the user retry with a different target. |
| R9 | `share()` returns before the target app has actually received the data ("fire and forget"). | §3.5 / spec [S4] | Low | Do not show a "shared successfully" toast. The promise resolving means the OS accepted the payload, not that WhatsApp sent it. |
| R10 | Desktop Chrome on macOS/Linux before 128 has `canShare` but no working file share. | §2 | Low | `canShare({files})` is the gate; if it returns false the button is not rendered. |
| R11 | Firefox desktop / Android WebView have no `navigator.share` at all. | §2 [S1] | Low | The button is not rendered. Nothing else to do. |
| R12 | The `HEAD` probe doubles the request count for every share. | — | Low | The `HEAD` is ~1 round-trip of headers; and the resulting `File` is memoised, so a second share of the same item does no I/O. |
| R13 | The service worker interferes with the media fetch. | §3.6 | Low | Already handled: `client/public/sw.js` bypasses `/api/` and any `Range` request. Nothing to change. |

---

## 8. Open questions

1. **Should the button be visible-but-disabled, or hidden, when file sharing is unavailable?** Recommendation: **hidden**, because the download anchor is already one tap away and a disabled control is a dead end. But a visible button that explains *why* ("not supported on this browser") may be better for discoverability. — *Needs a product call.*
2. **Should a file above 50 MiB fall back to link share automatically, or should the app refuse and let the user pick?** Recommendation: automatic link-share fallback with a clear label. — *Needs a product call.*
3. **Should we invest in PWA-ification beyond what's already there?** The manifest + SW already exist, so the answer for *this* feature is "no work needed". But adding `share_target` would let Foldergram **receive** shared media into the library, which is arguably the bigger win. — *Separate feature, needs scoping.*
4. **How should `.m4v` be handled?** The extension is permitted but `video/x-m4v` is not a permitted MIME type [S6]. Options: (a) label `.m4v` as `video/mp4` (the containers are close relatives and many apps accept it), (b) refuse file-share for `.m4v`. — *Needs a call; (a) is my recommendation but it is a small lie about the MIME type.*
5. **Should the share include the caption or a link alongside the file?** Recommendation: **no** — see R5; mixing `files` with `url`/`text` produces inconsistent behaviour in receiving apps [S13]. But some users want a caption. — *Needs a product call.*
6. **Multi-select share?** The API allows up to 10 files [S5]. Foldergram has multi-select in the library/trash views. Out of scope for v1; the limit allows it later. — *Confirm deferral.*
7. **Do we want a server-side `Content-Disposition` on the plain `/api/originals/:id` route?** Not required for sharing (the `File` name comes from the JS side), and adding it would change the behaviour of the existing "open original" link. — *Recommendation: don't.*
8. **Which surfaces get the button first?** This plan proposes reels + post viewer. `FeedCard.vue` (menu), `StoriesModal.vue`, `ExploreGrid.vue` and `PostView`'s more-options menu are candidates. — *Scope decision.*

---

## Appendix A — Repo ground truth (files read)

| Fact | File |
|---|---|
| Web app manifest with `display: standalone`, icons, `start_url`/`scope` | `client/public/manifest.webmanifest` |
| Service worker; bypasses `/api/`, `/thumbnails/`, `/previews/`, `/originals/`, `Range` requests | `client/public/sw.js` |
| `<link rel="manifest">`, `mobile-web-app-capable`, `apple-*` metas, theme-color | `client/index.html` |
| SW registration (PROD only) | `client/src/main.ts:88-93` |
| No PWA plugin; manifest + SW are static files in `public/` | `client/vite.config.ts` |
| `requestJson` (JSON only, `credentials: 'same-origin'`, `x-foldergram-intent` on mutations) | `client/src/api/http.ts` |
| `getOriginalMediaUrl(id)` → `/api/originals/${id}`; `getOriginalMediaDownloadUrl(id)` → `?download=1` | `client/src/utils/original-media.ts` |
| `FeedItem` (has `filename`, `mediaType`; **no** `mimeType`/`fileSize`); `ImageDetail extends FeedItem` (has `mimeType`, `fileSize`, `originalUrl`) | `client/src/types/api.ts:69-91`, `:333-344` |
| Reels rail: like / bookmark / info / **download `<a>`** / folder link | `client/src/components/ReelActionRail.vue:1-58` |
| Rails rendered by the reels view (mobile slot + desktop) | `client/src/views/ReelsView.vue:38-143` |
| Post viewer sidebar action row; download `<a>` at 513-518, open-original `<a>` at 536-540 | `client/src/components/PostViewer.vue:461-540` |
| Feed card "more" menu: open original / download original / delete | `client/src/components/FeedCard.vue:306-360`, `:951-957` |
| `GET /api/originals/:id` — `?download=1` → `response.download(path, filename)`; else `response.sendFile(path)` | `server/src/routes/api.ts:1343-1359` |
| `/thumbnails` + `/previews` behind `requireMediaAuthentication`; `/api` behind `requireApiAuthentication`; SPA fallback regex excludes `/api`, `/thumbnails`, `/previews` | `server/src/app.ts:34-68` |
| Video previews are never served — `/previews/*.mp4` 302-redirects to `/api/originals/:id` (**no mp4 transcode fallback exists**) | `server/src/routes/lazy-derivatives.ts:126-130` |
| `images` table columns `mime_type`, `file_size`, `filename`, `extension`, `media_type` | `server/src/db/schema.ts:28-35` |
| Server extension→MIME map (incl. `.mov`→`video/quicktime`, `.mkv`→`video/x-matroska`, `.m4v`→`video/x-m4v`) | `server/src/utils/image-utils.ts:50-73` |
| Feed SQL projection selects `images.filename` but **not** `mime_type`/`file_size`; the image-detail query does | `server/src/db/repositories.ts:262-293` vs `:1833-1836` |
| `filename` is a bare basename (`path.basename(file.absolutePath)`) | `server/src/services/scanner-service.ts:2584, 2672, 2697` |
| `Content-Type`/`Content-Length` are set before the HEAD short-circuit; `206` range support | `node_modules/send/index.js:508-588` |
| Locale files must have identical leaf-path sets across en/es/zh | `client/src/locales/validation.test.ts` |
| Docs sidebar is an explicit list; `docs/plans/` has no entry | `docs/.vitepress/config.ts` |
| HTTPS is the documented deployment requirement | `docs/deployment.md:185`; `docs/security.md:153-156` |
| **No existing share/clipboard affordance anywhere in `client/src`** | grep for `navigator.share|navigator.canShare|clipboard|copyLink|shareUrl` → 0 matches |

## Appendix B — Sources

All checked **2026-11-02**.

- **[S1]** MDN browser-compat-data — `api/Navigator.json` (`share`, `share.data_files_parameter`, `canShare`) and `api/UserActivation.json`. <https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json> (raw: <https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json>); <https://github.com/mdn/browser-compat-data/blob/main/api/UserActivation.json>
- **[S2]** MDN browser-compat-data — `api/UserActivation.json` (`isActive`: Chrome 72+, Safari 16.4+, Firefox 120+). <https://github.com/mdn/browser-compat-data/blob/main/api/UserActivation.json>
- **[S3]** Can I Use — Web Share API. <https://caniuse.com/web-share>
- **[S4]** W3C — Web Share API, W3C Recommendation 30 May 2023. <https://www.w3.org/TR/web-share/>
- **[S5]** Chromium source (main) — `third_party/blink/renderer/modules/webshare/navigator_share.cc`: `kMaxSharedFileCount = 10`, `kMaxSharedFileBytes = 50U * 1024 * 1024`, `kMaxTitleLength = 16U * 1024`, `kMaxTextLength = 120U * 1024` (Android) / `1U * 1024 * 1024`, `kMaxUrlLength = 16U * 1024`; transient-activation check and its error text. <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webshare/navigator_share.cc>
- **[S6]** Chromium source (main) — `components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/ShareServiceImpl.java` (`MAX_SHARED_FILE_COUNT = 10`, `MAX_SHARED_FILE_BYTES = 50 * 1024 * 1024`, `PERMITTED_EXTENSIONS`, `PERMITTED_MIME_TYPES`, `isDangerousFilename`, `isDangerousMimeType`, temp-file + `FileProviderUtils.getContentUriFromFile` flow) and `SharedFileCollator.java` (`commonMimeType`). <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/>
- **[S7]** Chromium source (main) — `third_party/blink/public/common/frame/user_activation_state.h`: `kActivationLifespan = base::Seconds(5)` (60 s only under `MEMORY_SANITIZER`). <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/public/common/frame/user_activation_state.h>
- **[S8]** Chromium source (main) — `chrome/android/java/src/org/chromium/chrome/browser/webshare/ShareServiceImplementationFactory.java`: the `ShareService` Mojo is registered browser-side. <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/android/java/src/org/chromium/chrome/browser/webshare/ShareServiceImplementationFactory.java>
- **[S9]** Chromium commit "Extend UAv2 transient activation expiry time to 5sec" (2019). <https://chromium.googlesource.com/chromium/src/+/231d25ff06df1691d1de539dcdebf65ca5bd5ef7>
- **[S10]** MDN — Transient activation glossary. <https://developer.mozilla.org/en-US/docs/Glossary/Transient_activation>
- **[S11]** web.dev — "Integrate with the OS sharing UI with the Web Share API" (HTTPS-only, user-action-only, `allow="web-share"`, `canShare` for files). <https://web.dev/articles/web-share>
- **[S12]** Google Chrome Web Share Demo (install required to *receive*, not to send). <https://googlechrome.github.io/samples/web-share/>
- **[S13]** W3C web-share issue #279 — "Web Share API fails to share a fully loaded data object/partial data object with file" (receiving apps discarding parts of mixed payloads; closed 2025-11-11 as "not a spec issue"). <https://github.com/w3c/web-share/issues/279>
- **[S14]** Android Developers — "Send data to other apps" (Sharesheet, `ACTION_SEND`, `EXTRA_STREAM`, MIME-type table). <https://developer.android.com/develop/ui/compose/sharing/send>
- **[S15]** Android Developers — "Sharing files" (`FileProvider`, content URI + temporary read permission). <https://developer.android.com/training/secure-file-sharing>
- **[S16]** Chromium source (main) — `chrome/android/java/src/org/chromium/chrome/browser/share/ShareHelper.java`: `getShareFileAppCompatibilityIntent` → `Intent.ACTION_SEND` + `intent.setType(fileContentType)`. <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/android/java/src/org/chromium/chrome/browser/share/ShareHelper.java>
- **[S17]** Android Developers — `<data>` manifest element (`android:mimeType` wildcard subtype; case-sensitive MIME matching). <https://developer.android.com/guide/topics/manifest/data-element>
- **[S18]** MDN — `Navigator.share()` (exceptions, shareable file types, security/transient-activation requirement). <https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share>
- **[S19]** MDN — "Share data between apps" (PWA guidance: `canShare` feature detection before showing share UI). <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Share_data_between_apps>
