-- migrate:up
-- The indexes the AI queue needs.
--
-- The queue reports how far it has come by reading the whole video table:
--
--   SELECT ai_status, COUNT(*) FROM images
--    WHERE media_type = 'video' AND is_deleted = false GROUP BY ai_status
--
--   SELECT MIN(ai_analyzed_at) FROM images WHERE ai_status = 'pending'
--
--   SELECT COUNT(*) FROM images
--    WHERE media_type = 'video' AND is_deleted = false AND ai_status = 'pending'
--
-- Without an index those are scans of the whole table, and the queue asks
-- for them after every video it finishes: the table is read again and again
-- while nothing in it changed. These indexes turn the scans into a walk over
-- the index alone.
--
-- The index on the pending rows carries the analysed timestamp, so the
-- "how old is the backlog" question is answered from the index too.
CREATE INDEX IF NOT EXISTS idx_images_video_ai_status
  ON images (ai_status)
  WHERE media_type = 'video' AND is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_images_pending_analyzed_at
  ON images (ai_analyzed_at)
  WHERE ai_status = 'pending';

-- The canonicalizer asks for the languages that are already known before
-- every video. The list of the languages is in the index, so the answer does
-- not need the table.
CREATE INDEX IF NOT EXISTS idx_images_known_language
  ON images (ai_language)
  WHERE ai_language IS NOT NULL AND ai_language <> '';

-- migrate:down
DROP INDEX IF EXISTS idx_images_known_language;
DROP INDEX IF EXISTS idx_images_pending_analyzed_at;
DROP INDEX IF EXISTS idx_images_video_ai_status;
