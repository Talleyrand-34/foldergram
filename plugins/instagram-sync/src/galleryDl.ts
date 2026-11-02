/**
 * Locating and version-probing the vendored gallery-dl.
 *
 * The install is versioned:
 *
 *   <root>/versions/<version>/gallery_dl/   ← the package
 *   <root>/current -> versions/<version>    ← symlink flipped on update
 *
 * IMPORTANT: `PYTHONPATH` must point at the directory that CONTAINS the
 * `gallery_dl` package — i.e. `<root>/current`, which resolves to the version
 * directory. Pointing it at `<root>/current/gallery_dl` fails with
 * `ModuleNotFoundError`, because Python then looks for `current/gallery_dl/`.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Directory to place on PYTHONPATH. */
export function galleryDlPackageDir(root: string): string {
  return path.join(root, "current");
}

/** Directory holding the versioned installs. */
export function galleryDlVersionsDir(root: string): string {
  return path.join(root, "versions");
}

export function galleryDlVersionDir(root: string, version: string): string {
  return path.join(galleryDlVersionsDir(root), version);
}

/**
 * Read the installed version from `gallery_dl/version.py`.
 * Reading the file is cheaper and safer than spawning Python to ask.
 */
export async function readInstalledVersion(root: string): Promise<string | null> {
  const versionFile = path.join(
    galleryDlPackageDir(root),
    "gallery_dl",
    "version.py"
  );
  try {
    const text = await fs.readFile(versionFile, "utf8");
    const match = /__version__\s*=\s*["']([^"']+)["']/.exec(text);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare two dotted versions numerically, padding the shorter one.
 * Returns <0 when `a` is older, 0 when equal, >0 when `a` is newer.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function isVersionAtLeast(version: string, floor: string): boolean {
  return compareVersions(version, floor) >= 0;
}

/** Versions present on disk, newest first. */
export async function listInstalledVersions(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(galleryDlVersionsDir(root), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
}
