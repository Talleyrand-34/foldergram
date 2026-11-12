/**
 * "Share as file" (Web Share API Level 2) - capability checks and helpers.
 *
 * The browser decides whether a file can be handed to the OS share sheet, and
 * the rules are Chromium's, not ours:
 *
 *  - the whole payload of one `share()` call may not exceed 50 MiB,
 *  - at most 10 files per call,
 *  - only a fixed list of extensions and MIME types is accepted,
 *  - the file name has to be a bare, safe basename.
 *
 * The references for every number and list below are in
 * `docs/plans/share-media-as-file.md`.
 */

/**
 * The maximum total size of the files in one share call, in bytes.
 *
 * Chromium rejects a bigger payload with `NotAllowedError` before the share
 * sheet ever opens, so the size has to be checked up front.
 */
export const SHARE_MAX_BYTES = 52_428_800;

/** The extensions Chromium accepts in a shared file. */
export const SHARE_PERMITTED_EXTENSIONS: ReadonlySet<string> = new Set([
  'avif', 'bmp', 'css', 'csv', 'ehtml', 'flac', 'gif', 'htm', 'html', 'ico',
  'jfif', 'jpeg', 'jpg', 'm4a', 'm4v', 'mp3', 'mp4', 'mpeg', 'mpg', 'oga',
  'ogg', 'ogm', 'ogv', 'opus', 'pdf', 'pjp', 'pjpeg', 'png', 'shtm', 'shtml',
  'svg', 'svgz', 'text', 'tif', 'tiff', 'txt', 'wav', 'weba', 'webm', 'webp',
  'xbm'
]);

/** The MIME types Chromium accepts in a shared file. */
export const SHARE_PERMITTED_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/flac', 'application/pdf', 'audio/mp3', 'audio/mpeg', 'audio/ogg',
  'audio/wav', 'audio/webm', 'audio/x-m4a', 'image/avif', 'image/bmp',
  'image/gif', 'image/jpeg', 'image/png', 'image/svg+xml', 'image/tiff',
  'image/webp', 'image/x-icon', 'image/x-ms-bmp', 'image/x-xbitmap',
  'text/comma-separated-values', 'text/css', 'text/csv', 'text/html',
  'text/plain', 'video/mp4', 'video/mpeg', 'video/ogg', 'video/webm'
]);

/** The lower case extension of a file name, without the dot. */
export function getFileExtension(name: string): string {
  const separator = name.lastIndexOf('.');
  if (separator <= 0 || separator === name.length - 1) {
    return '';
  }

  return name.slice(separator + 1).toLowerCase();
}

/**
 * Whether a file name may be used for a shared file.
 *
 * Chromium rejects a name that is empty, contains a path separator or `..`,
 * has leading or trailing whitespace, ends with a dot, or whose extension is
 * not on the allowlist.
 */
export function isShareableFileName(name: string): boolean {
  if (!name || name === '.' || name === '..') {
    return false;
  }

  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return false;
  }

  if (name !== name.trim() || name.endsWith('.')) {
    return false;
  }

  return SHARE_PERMITTED_EXTENSIONS.has(getFileExtension(name));
}

/**
 * Turns a stored file name into one that is safe to share.
 *
 * The scanner already stores a bare basename, so this is mostly a safety net
 * for names that come from somewhere else. It returns an empty string when
 * nothing shareable is left.
 */
export function buildShareFileName(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? '';
  const trimmed = basename.trim().replace(/\.+$/, '');

  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return '';
  }

  return trimmed;
}

/**
 * Whether this browser can share files at all.
 *
 * The API only exists in a secure context, so a plain HTTP origin - the LAN
 * test instances - simply does not have it.
 */
export function canShareFiles(): boolean {
  // The API only exists in a secure context, so its presence already proves
  // it. The explicit check only rules out a browser that says it is not
  // secure, which is what happens on a plain HTTP origin.
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return false;
  }

  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  );
}

/**
 * Whether this browser accepts a file of this type.
 *
 * The probe is an empty file: `canShare` looks at the name and the type, not
 * at the content.
 */
export function probeShareSupport(mimeType: string, name: string): boolean {
  if (!canShareFiles() || !isShareableFileName(name)) {
    return false;
  }

  try {
    return navigator.canShare({ files: [new File([], name, { type: mimeType })] });
  } catch {
    return false;
  }
}

/**
 * The MIME type a file name suggests.
 *
 * It mirrors the table of the server (`server/src/utils/image-utils.ts`), so
 * the probe can be done before the file is fetched. Only the types Chromium
 * accepts are listed; anything else is not shareable.
 */
export function guessMimeTypeFromFilename(filename: string): string {
  switch (getFileExtension(filename)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'svg':
      return 'image/svg+xml';
    case 'ico':
      return 'image/x-icon';
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mpeg':
    case 'mpg':
      return 'video/mpeg';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/x-m4a';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'ogv':
      return 'video/ogg';
    case 'flac':
      return 'audio/flac';
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain';
    case 'csv':
      return 'text/comma-separated-values';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'css':
      return 'text/css';
    default:
      return '';
  }
}

/**
 * The MIME type to label a shared file with.
 *
 * The type of the bytes wins over the type of the name: a `.m4v` whose bytes
 * are really MP4 can be shared when it is labelled `video/mp4`, but a `.mov`
 * cannot be shared at all, because Chromium checks the extension too.
 */
export function resolveShareMimeType(
  filename: string,
  fallback: string | null | undefined
): string {
  const candidate = fallback?.trim().toLowerCase();

  if (candidate && SHARE_PERMITTED_MIME_TYPES.has(candidate)) {
    return candidate;
  }

  return guessMimeTypeFromFilename(filename);
}
