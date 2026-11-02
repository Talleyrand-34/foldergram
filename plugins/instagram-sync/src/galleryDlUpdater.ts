/**
 * gallery-dl self-updater.
 *
 * Downloads a release from PyPI, verifies it against the digest PyPI
 * published, extracts it, smoke-tests it, and only then flips the active
 * symlink. Every failure path leaves the currently installed version working.
 *
 * The install is versioned:
 *   <root>/versions/<version>/gallery_dl/   ← the package
 *   <root>/current -> versions/<version>    ← symlink flipped atomically
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { compareVersions, galleryDlPackageDir, galleryDlVersionDir } from "./galleryDl.js";

const execFileAsync = promisify(execFile);

const PYPI_JSON_URL = "https://pypi.org/pypi/gallery-dl/json";
const PYPI_HOST = "https://files.pythonhosted.org";

export interface PyPIRelease {
  version: string;
  sdistUrl: string;
  sha256: string;
  size: number;
}

/** Query PyPI for the latest gallery-dl release. */
export async function fetchLatestRelease(): Promise<PyPIRelease | null> {
  const response = await fetch(PYPI_JSON_URL, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`PyPI query failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    info?: { version?: string };
    urls?: Array<{
      packagetype?: string;
      url?: string;
      size?: number;
      digests?: { sha256?: string };
    }>;
  };

  const version = payload.info?.version;
  if (!version) {
    throw new Error("PyPI response did not contain a version");
  }

  const sdist = (payload.urls ?? []).find((entry) => entry.packagetype === "sdist");
  const url = sdist?.url;
  const sha256 = sdist?.digests?.sha256;
  if (!url || !sha256) {
    throw new Error(`PyPI response did not contain a verifiable sdist for ${version}`);
  }

  return { version, sdistUrl: url, sha256, size: sdist?.size ?? 0 };
}

/** Download the sdist and verify its sha256 against the digest PyPI published. */
async function downloadVerified(release: PyPIRelease, targetPath: string): Promise<void> {
  const response = await fetch(release.sdistUrl);
  if (!response.ok) {
    throw new Error(`download of ${release.version} failed with status ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256.toLowerCase()) {
    throw new Error(
      `sha256 mismatch for ${release.version}: expected ${release.sha256}, got ${digest}`
    );
  }

  await fs.writeFile(targetPath, bytes);
}

/**
 * Extract the sdist so that `<dest>/gallery_dl/` is the package.
 * Prefers `tar` (always present on Debian) and falls back to Python's stdlib
 * tarfile, whose `data` filter rejects absolute paths and `..`.
 */
async function extractSdist(tarballPath: string, dest: string): Promise<void> {
  try {
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", dest, "--strip-components=1"], {
      maxBuffer: 8 * 1024 * 1024
    });
    return;
  } catch {
    // fall through to the Python fallback
  }

  const script =
    "import sys, tarfile\n" +
    "with tarfile.open(sys.argv[1]) as t:\n" +
    "    t.extractall(sys.argv[2], filter='data')\n";
  await execFileAsync("python3", ["-c", script, tarballPath, dest], {
    maxBuffer: 8 * 1024 * 1024
  });
}

/** Run `python3 -m gallery_dl --version` against a candidate install. */
async function probeVersion(packageDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      ["-m", "gallery_dl", "--version"],
      {
        env: { ...process.env, PYTHONPATH: packageDir },
        maxBuffer: 1024 * 1024,
        timeout: 60_000
      }
    );
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout);
    return match ? match[1] : stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Move an extracted `gallery_dl` package into its version directory.
 *
 * The version directory must CONTAIN the package — `PYTHONPATH` points at the
 * version directory and Python looks for `<versionDir>/gallery_dl/`. Renaming
 * the package onto the version directory itself puts it one level too high and
 * breaks the import.
 */
export async function installExtractedPackage(
  scratchDir: string,
  versionDir: string
): Promise<string> {
  const packageDir = path.join(scratchDir, "gallery_dl");
  try {
    await fs.access(packageDir);
  } catch {
    throw new Error(`extracted archive has no gallery_dl package`);
  }

  const installedPackageDir = path.join(versionDir, "gallery_dl");
  await fs.rm(versionDir, { recursive: true, force: true });
  await fs.mkdir(versionDir, { recursive: true });
  await fs.rename(packageDir, installedPackageDir);
  return installedPackageDir;
}

/**
 * Install a release and make it active.
 * Returns the version that is now active.
 */
export async function installRelease(release: PyPIRelease, root: string): Promise<string> {
  const versionsDir = path.join(root, "versions");
  await fs.mkdir(versionsDir, { recursive: true });

  const versionDir = galleryDlVersionDir(root, release.version);
  const tarballPath = path.join(root, `.gallery-dl-${release.version}.tar.gz`);
  const scratchDir = path.join(root, `.extract-${release.version}`);

  try {
    await downloadVerified(release, tarballPath);

    // Extract into a scratch dir first so a failed extraction never leaves a
    // half-written version directory behind.
    await fs.rm(scratchDir, { recursive: true, force: true });
    await fs.mkdir(scratchDir, { recursive: true });
    await extractSdist(tarballPath, scratchDir);

    await installExtractedPackage(scratchDir, versionDir);

    // Smoke-test before activating. A version that cannot even report its own
    // version is not worth switching to.
    const probed = await probeVersion(versionDir);
    if (!probed) {
      await fs.rm(versionDir, { recursive: true, force: true });
      throw new Error(`gallery-dl ${release.version} failed its version smoke test`);
    }

    await activateVersion(root, release.version);
    return release.version;
  } finally {
    await fs.rm(tarballPath, { force: true }).catch(() => undefined);
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Point `current` at a version directory. The rename is atomic. */
export async function activateVersion(root: string, version: string): Promise<void> {
  const target = path.join("versions", version);
  const linkPath = path.join(root, "current");
  const tempLink = path.join(root, "current.tmp");

  await fs.rm(tempLink, { force: true }).catch(() => undefined);
  await fs.symlink(target, tempLink);
  await fs.rename(tempLink, linkPath);
}

/** Remove version directories other than the active one, keeping one spare. */
export async function pruneVersions(root: string, keep = 2): Promise<void> {
  const versionsDir = path.join(root, "versions");
  let entries: string[];
  try {
    entries = (await fs.readdir(versionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }

  const active = await fs.readlink(path.join(root, "current")).catch(() => null);
  const activeVersion = active ? path.basename(active) : null;

  const sorted = entries.sort((a, b) => compareVersions(b, a));
  let kept = 0;
  for (const version of sorted) {
    if (version === activeVersion) continue;
    kept += 1;
    if (kept <= keep) continue;
    await fs.rm(path.join(versionsDir, version), { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

/** Resolve the PyPI download host, kept separate so it can be asserted in tests. */
export function pypiHost(): string {
  return PYPI_HOST;
}

interface CachedLatest {
  version: string | null;
  checkedAt: number;
}

/**
 * The last known PyPI version, cached so `/status` can report it without
 * hitting PyPI on every poll (the client polls `/status` every 10 s).
 */
let cachedLatest: CachedLatest = { version: null, checkedAt: 0 };

const LATEST_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Latest gallery-dl version on PyPI, or null when it cannot be determined.
 * The result is cached for 30 minutes; a failed lookup is cached too, so an
 * offline server does not retry on every request.
 */
export async function latestKnownVersion(force = false): Promise<string | null> {
  const now = Date.now();
  if (!force && now - cachedLatest.checkedAt < LATEST_CACHE_TTL_MS) {
    return cachedLatest.version;
  }

  try {
    const release = await fetchLatestRelease();
    cachedLatest = { version: release?.version ?? null, checkedAt: now };
  } catch {
    cachedLatest = { version: null, checkedAt: now };
  }
  return cachedLatest.version;
}

export { galleryDlPackageDir };
