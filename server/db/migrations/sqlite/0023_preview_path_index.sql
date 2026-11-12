-- migrate:up
-- The lazy derivative route looks the media up by its preview path when the
-- file is not on disk yet. That lookup had no index, so it was a sequential
-- scan over the whole images table: on a library with a hundred thousand
-- media it took seconds, and with several requests in parallel it took
-- minutes, so the first request of every missing preview timed out and the
-- media never appeared.
--
-- The thumbnail lookup had an index (000005_thumbnail_path_index.sql) and was
-- fast, which is why the feed showed thumbnails while the media itself did
-- not open.
CREATE INDEX IF NOT EXISTS idx_images_preview_path ON images(preview_path) WHERE is_deleted = 0;

-- migrate:down
DROP INDEX IF EXISTS idx_images_preview_path;
