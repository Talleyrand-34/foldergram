import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * An isolated data root for a single test file.
 *
 * The server resolves every storage path from the environment, so a test only
 * has to redirect `DATA_ROOT` / `GALLERY_ROOT` / `DB_DIR` / `THUMBNAILS_DIR` /
 * `PREVIEWS_DIR` to get a completely isolated library, database and derivative
 * directories.
 */
export interface TempDataRoot {
  /** The temporary directory that contains everything below. */
  readonly root: string;
  readonly dataRoot: string;
  readonly galleryRoot: string;
  readonly dbDir: string;
  readonly thumbnailsDir: string;
  readonly previewsDir: string;
  /** Creates the directory tree (idempotent). */
  ensure(): Promise<void>;
  /** Removes the whole tree (idempotent). */
  remove(): Promise<void>;
}

export interface TempDataRootOptions {
  /** Prefix for the temporary directory name. */
  readonly prefix?: string;
}

export async function createTempDataRoot(options: TempDataRootOptions = {}): Promise<TempDataRoot> {
  const prefix = options.prefix ?? 'foldergram-test-';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));

  const dataRoot = path.join(root, 'data');
  const galleryRoot = path.join(root, 'gallery');
  const dbDir = path.join(root, 'db');
  const thumbnailsDir = path.join(root, 'thumbnails');
  const previewsDir = path.join(root, 'previews');

  const tempDataRoot: TempDataRoot = {
    root,
    dataRoot,
    galleryRoot,
    dbDir,
    thumbnailsDir,
    previewsDir,
    async ensure(): Promise<void> {
      await Promise.all(
        [dataRoot, galleryRoot, dbDir, thumbnailsDir, previewsDir].map((directory) =>
          fs.mkdir(directory, { recursive: true })
        )
      );
    },
    async remove(): Promise<void> {
      await fs.rm(root, { recursive: true, force: true });
    }
  };

  await tempDataRoot.ensure();

  return tempDataRoot;
}

/**
 * Points every storage-related environment variable at the given temp root.
 *
 * `vi.stubEnv` is used on purpose: it is undone by `vi.unstubAllEnvs()` and it
 * keeps the rest of `process.env` untouched.
 */
export function stubDataRootEnv(
  tempDataRoot: TempDataRoot,
  stubEnv: (name: string, value: string) => void
): void {
  stubEnv('NODE_ENV', 'test');
  stubEnv('DATA_ROOT', tempDataRoot.dataRoot);
  stubEnv('GALLERY_ROOT', tempDataRoot.galleryRoot);
  stubEnv('DB_DIR', tempDataRoot.dbDir);
  stubEnv('THUMBNAILS_DIR', tempDataRoot.thumbnailsDir);
  stubEnv('PREVIEWS_DIR', tempDataRoot.previewsDir);
}
