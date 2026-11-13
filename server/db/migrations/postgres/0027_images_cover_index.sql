-- migrate:up
-- The explicit cover of a folder is the file named cover.*.
--
-- The lookup could not use an index: LOWER(filename) IN ('cover.jpg', ...)
-- is not something a b-tree can answer, so the query scanned every image of
-- the folder. It runs once per folder on every scan, and once per analysed
-- video, because writing the caption wakes the gallery service - and with
-- folders holding thousands of images each lookup took seconds.
--
-- With the index it is an index seek and the folder's cover is found at
-- once.
CREATE INDEX IF NOT EXISTS idx_images_cover
  ON images (folder_id, LOWER(filename))
  WHERE is_deleted = false AND is_trashed = false;

-- migrate:down
DROP INDEX IF EXISTS idx_images_cover;
