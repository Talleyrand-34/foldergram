import { DatabaseSync } from 'node:sqlite';

import { sqliteAll, sqliteGet } from './driver/sqlite-raw.js';

interface ForeignKeyRecord {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

export function tableExists(database: DatabaseSync, name: string): boolean {
  const row = sqliteGet(database, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name) as
    | { name: string }
    | undefined;

  return row?.name === name;
}

export function tableHasColumn(database: DatabaseSync, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }

  const columns = sqliteAll(database, `PRAGMA table_info(${tableName})`) as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function tableHasForeignKey(database: DatabaseSync, tableName: string, options: {
  from: string;
  toTable: string;
  toColumn: string;
  onDelete: string;
}): boolean {
  if (!tableExists(database, tableName)) {
    return false;
  }

  const foreignKeys = sqliteAll(database, `PRAGMA foreign_key_list(${tableName})`) as unknown as ForeignKeyRecord[];
  return foreignKeys.some((foreignKey) =>
    foreignKey.from === options.from &&
    foreignKey.table === options.toTable &&
    foreignKey.to === options.toColumn &&
    foreignKey.on_delete.toUpperCase() === options.onDelete.toUpperCase()
  );
}

export function assertNoLegacySchema(database: DatabaseSync): void {
  const hasLegacyProfilesTable = tableExists(database, 'profiles');
  const imagesUseLegacyProfileId = tableHasColumn(database, 'images', 'profile_id');

  if (!hasLegacyProfilesTable && !imagesUseLegacyProfileId) {
    return;
  }

  throw new Error('Legacy database schema detected. Delete the SQLite file and restart the app to rebuild the database with folders/folder_id tables.');
}

export function applyBaselineCompatMigrations(database: DatabaseSync): void {
  if (tableExists(database, 'folders') && !tableHasColumn(database, 'folders', 'description')) {
    database.exec('ALTER TABLE folders ADD COLUMN description TEXT NULL');
  }

  if (tableExists(database, 'folders') && !tableHasColumn(database, 'folders', 'avatar_image_id')) {
    database.exec('ALTER TABLE folders ADD COLUMN avatar_image_id INTEGER NULL');
  }

  if (tableExists(database, 'folders') && !tableHasColumn(database, 'folders', 'avatar_source')) {
    database.exec("ALTER TABLE folders ADD COLUMN avatar_source TEXT NOT NULL DEFAULT 'auto'");
  }

  if (tableExists(database, 'folders') && !tableHasColumn(database, 'folders', 'role')) {
    database.exec("ALTER TABLE folders ADD COLUMN role TEXT NOT NULL DEFAULT 'normal'");
  }

  if (tableExists(database, 'folders') && !tableHasColumn(database, 'folders', 'story_owner_folder_id')) {
    database.exec('ALTER TABLE folders ADD COLUMN story_owner_folder_id INTEGER NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'media_type')) {
    database.exec("ALTER TABLE images ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image'");
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'duration_ms')) {
    database.exec('ALTER TABLE images ADD COLUMN duration_ms REAL NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'display_orientation')) {
    database.exec('ALTER TABLE images ADD COLUMN display_orientation INTEGER NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'is_animated')) {
    database.exec('ALTER TABLE images ADD COLUMN is_animated INTEGER NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'taken_at')) {
    database.exec('ALTER TABLE images ADD COLUMN taken_at INTEGER NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'taken_at_source')) {
    database.exec('ALTER TABLE images ADD COLUMN taken_at_source TEXT NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'exif_json')) {
    database.exec('ALTER TABLE images ADD COLUMN exif_json TEXT NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'playback_strategy')) {
    database.exec("ALTER TABLE images ADD COLUMN playback_strategy TEXT NOT NULL DEFAULT 'preview'");
  }

  if (tableExists(database, 'images') && tableHasColumn(database, 'images', 'playback_strategy')) {
    database.exec("UPDATE images SET playback_strategy = 'preview' WHERE playback_strategy IS NULL OR playback_strategy = ''");
  }

  if (tableExists(database, 'images') && tableHasColumn(database, 'images', 'is_animated')) {
    database.exec("UPDATE images SET is_animated = 0 WHERE media_type = 'video' AND is_animated IS NULL");
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'is_trashed')) {
    database.exec('ALTER TABLE images ADD COLUMN is_trashed INTEGER NOT NULL DEFAULT 0');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'asset_key')) {
    database.exec('ALTER TABLE images ADD COLUMN asset_key TEXT NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'place_id')) {
    database.exec('ALTER TABLE images ADD COLUMN place_id INTEGER NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'deleted_at')) {
    database.exec('ALTER TABLE images ADD COLUMN deleted_at TEXT NULL');
  }

  if (tableExists(database, 'images') && !tableHasColumn(database, 'images', 'trashed_at')) {
    database.exec('ALTER TABLE images ADD COLUMN trashed_at TEXT NULL');
  }

  if (tableExists(database, 'images') && tableHasColumn(database, 'images', 'deleted_at')) {
    database.exec("UPDATE images SET deleted_at = updated_at WHERE is_deleted = 1 AND deleted_at IS NULL");
    database.exec('UPDATE images SET deleted_at = NULL WHERE is_deleted = 0');
  }

  if (tableExists(database, 'images') && tableHasColumn(database, 'images', 'is_trashed') && tableHasColumn(database, 'images', 'trashed_at')) {
    database.exec('UPDATE images SET trashed_at = NULL WHERE is_trashed = 0');
  }
}

function foldersNeedBaselineForeignKeyRebuild(database: DatabaseSync): boolean {
  return tableExists(database, 'folders') && (
    !tableHasForeignKey(database, 'folders', {
      from: 'avatar_image_id',
      toTable: 'images',
      toColumn: 'id',
      onDelete: 'NO ACTION'
    }) ||
    !tableHasForeignKey(database, 'folders', {
      from: 'story_owner_folder_id',
      toTable: 'folders',
      toColumn: 'id',
      onDelete: 'SET NULL'
    })
  );
}

function imagesNeedBaselineForeignKeyRebuild(database: DatabaseSync): boolean {
  return tableExists(database, 'images') && (
    !tableHasForeignKey(database, 'images', {
      from: 'folder_id',
      toTable: 'folders',
      toColumn: 'id',
      onDelete: 'CASCADE'
    }) ||
    !tableHasForeignKey(database, 'images', {
      from: 'place_id',
      toTable: 'places',
      toColumn: 'id',
      onDelete: 'SET NULL'
    })
  );
}

function cleanOptionalBaselineForeignKeys(database: DatabaseSync): void {
  database.exec(`
    UPDATE folders
    SET avatar_image_id = NULL
    WHERE avatar_image_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM images WHERE images.id = folders.avatar_image_id);

    UPDATE folders
    SET story_owner_folder_id = NULL
    WHERE story_owner_folder_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM folders AS owner_folders WHERE owner_folders.id = folders.story_owner_folder_id);

    UPDATE images
    SET place_id = NULL
    WHERE place_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM places WHERE places.id = images.place_id);
  `);
}

function rebuildFoldersWithBaselineForeignKeys(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE IF EXISTS __foldergram_baseline_folders;

    CREATE TABLE __foldergram_baseline_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'normal',
      story_owner_folder_id INTEGER NULL,
      description TEXT NULL,
      avatar_image_id INTEGER NULL,
      avatar_source TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (avatar_image_id) REFERENCES images(id),
      FOREIGN KEY (story_owner_folder_id) REFERENCES __foldergram_baseline_folders(id) ON DELETE SET NULL
    );

    INSERT INTO __foldergram_baseline_folders(
      id,
      slug,
      name,
      folder_path,
      role,
      story_owner_folder_id,
      description,
      avatar_image_id,
      avatar_source,
      created_at,
      updated_at
    )
    SELECT
      id,
      slug,
      name,
      folder_path,
      role,
      story_owner_folder_id,
      description,
      avatar_image_id,
      avatar_source,
      created_at,
      updated_at
    FROM folders;

    DROP TABLE folders;
    ALTER TABLE __foldergram_baseline_folders RENAME TO folders;
  `);
}

function rebuildImagesWithBaselineForeignKeys(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE IF EXISTS __foldergram_baseline_images;

    CREATE TABLE __foldergram_baseline_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      place_id INTEGER NULL,
      asset_key TEXT NULL,
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      absolute_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      display_orientation INTEGER NULL,
      media_type TEXT NOT NULL DEFAULT 'image',
      mime_type TEXT NOT NULL,
      duration_ms REAL NULL,
      is_animated INTEGER NULL,
      checksum_or_fingerprint TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      first_seen_at TEXT NOT NULL,
      sort_timestamp INTEGER NOT NULL,
      taken_at INTEGER NULL,
      taken_at_source TEXT NULL,
      exif_json TEXT NULL,
      thumbnail_path TEXT NOT NULL,
      preview_path TEXT NOT NULL,
      playback_strategy TEXT NOT NULL DEFAULT 'preview',
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT NULL,
      is_trashed INTEGER NOT NULL DEFAULT 0,
      trashed_at TEXT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE,
      FOREIGN KEY (place_id) REFERENCES places(id) ON DELETE SET NULL
    );

    INSERT INTO __foldergram_baseline_images(
      id,
      folder_id,
      place_id,
      asset_key,
      filename,
      extension,
      relative_path,
      absolute_path,
      file_size,
      width,
      height,
      display_orientation,
      media_type,
      mime_type,
      duration_ms,
      is_animated,
      checksum_or_fingerprint,
      mtime_ms,
      first_seen_at,
      sort_timestamp,
      taken_at,
      taken_at_source,
      exif_json,
      thumbnail_path,
      preview_path,
      playback_strategy,
      is_deleted,
      deleted_at,
      is_trashed,
      trashed_at,
      created_at,
      updated_at
    )
    SELECT
      id,
      folder_id,
      place_id,
      asset_key,
      filename,
      extension,
      relative_path,
      absolute_path,
      file_size,
      width,
      height,
      display_orientation,
      media_type,
      mime_type,
      duration_ms,
      is_animated,
      checksum_or_fingerprint,
      mtime_ms,
      first_seen_at,
      sort_timestamp,
      taken_at,
      taken_at_source,
      exif_json,
      thumbnail_path,
      preview_path,
      playback_strategy,
      is_deleted,
      deleted_at,
      is_trashed,
      trashed_at,
      created_at,
      updated_at
    FROM images;

    DROP TABLE images;
    ALTER TABLE __foldergram_baseline_images RENAME TO images;
  `);
}

export function rebuildBaselineForeignKeys(database: DatabaseSync): boolean {
  const shouldRebuildFolders = foldersNeedBaselineForeignKeyRebuild(database);
  const shouldRebuildImages = imagesNeedBaselineForeignKeyRebuild(database);

  if (!shouldRebuildFolders && !shouldRebuildImages) {
    return false;
  }

  const foreignKeyState = sqliteGet(database, 'PRAGMA foreign_keys') as { foreign_keys: number };
  database.exec('PRAGMA foreign_keys = OFF');

  try {
    database.exec('BEGIN');
    cleanOptionalBaselineForeignKeys(database);

    if (shouldRebuildFolders) {
      rebuildFoldersWithBaselineForeignKeys(database);
    }

    if (shouldRebuildImages) {
      rebuildImagesWithBaselineForeignKeys(database);
    }

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec(`PRAGMA foreign_keys = ${foreignKeyState.foreign_keys === 1 ? 'ON' : 'OFF'}`);
  }

  return true;
}
