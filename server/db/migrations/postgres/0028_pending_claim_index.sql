-- migrate:up
-- The queue claims the next pending video with:
--
--   SELECT id, ... FROM images
--    WHERE media_type = 'video' AND is_deleted = false AND ai_status = 'pending'
--    ORDER BY id ASC LIMIT 1
--    FOR UPDATE SKIP LOCKED
--
-- Without an index that matches the order, the planner walks the primary
-- key from the first video until it finds one that is pending - and the
-- pending ones are the last ones to be indexed, so it walked a long way
-- every time. The index holds the pending videos in id order, so the claim
-- is a seek that stops at the first one.
CREATE INDEX IF NOT EXISTS idx_images_pending_video
  ON images (id)
  WHERE media_type = 'video' AND is_deleted = false AND ai_status = 'pending';

-- migrate:down
DROP INDEX IF EXISTS idx_images_pending_video;
