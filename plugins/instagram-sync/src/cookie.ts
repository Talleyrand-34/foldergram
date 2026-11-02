/**
 * Netscape cookie file handling.
 *
 * The cookie is a live Instagram session. It expires on its own and cannot be
 * refreshed without a human logging in, which makes it the single biggest
 * operational risk in this plugin. It is therefore:
 *   - stored 0600, outside the gallery's scanned tree,
 *   - validated before every run so an expired session fails fast instead of
 *     burning a full sync cycle,
 *   - never logged, never returned by a route, never stored in the DB.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface CookieValidation {
  ok: boolean;
  reason: string | null;
}

const INSTAGRAM_DOMAINS = new Set([".instagram.com", "instagram.com"]);

/**
 * Parse a Netscape cookie file into `name -> value`.
 * Comment lines (`#`) and blank lines are ignored.
 */
export function parseCookieFile(text: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const fields = line.split("\t");
    if (fields.length < 7) continue;

    const name = fields[5]?.trim();
    const value = fields[6]?.trim();
    if (!name) continue;
    cookies.set(name, value ?? "");
  }
  return cookies;
}

/**
 * Extract the domain of the `sessionid` cookie, which is what decides whether
 * the session is usable for Instagram.
 */
function findSessionIdDomain(text: string): string | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const fields = line.split("\t");
    if (fields.length < 7) continue;
    if (fields[5]?.trim() !== "sessionid") continue;
    return fields[0]?.trim() ?? "";
  }
  return null;
}

/**
 * A usable cookie file must parse and carry a `sessionid` scoped to
 * Instagram. Anything else means the session is missing or expired.
 */
export function validateCookie(text: string): CookieValidation {
  if (!text.trim()) {
    return { ok: false, reason: "cookie file is empty" };
  }

  const cookies = parseCookieFile(text);
  if (cookies.size === 0) {
    return { ok: false, reason: "cookie file contains no cookies" };
  }

  const sessionId = cookies.get("sessionid");
  if (!sessionId) {
    return { ok: false, reason: "cookie file has no sessionid for .instagram.com" };
  }

  const domain = findSessionIdDomain(text);
  if (domain === null || !INSTAGRAM_DOMAINS.has(domain)) {
    return {
      ok: false,
      reason: `sessionid is scoped to "${domain ?? "unknown"}" instead of .instagram.com`
    };
  }

  return { ok: true, reason: null };
}

export async function readCookieFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write the cookie file atomically with mode 0600.
 * The temp file gets the mode before the rename so the credential is never
 * briefly world-readable.
 */
export async function writeCookieFile(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
}

/** mtime of the cookie file, used to show when the session was last refreshed. */
export async function readCookieUpdatedAt(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtime.toISOString();
  } catch {
    return null;
  }
}
