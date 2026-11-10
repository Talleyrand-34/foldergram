-- migrate:up
-- 0021_collection_membership_moment.sql — restore the moment a media joined
-- a collection.
--
-- The collections are ordered by "the collection with the last added post",
-- so the moment a media joined its collection has to mean something.
--
-- It used to be restamped on every re-add, and the Instagram mirror re-adds
-- the whole collection on every poll — so every media carried the poll's
-- timestamp and the order said nothing at all.
--
-- The moment is restored from the media's own arrival in the library: a
-- media cannot have joined a collection before it existed. The earlier of the
-- two is the truth, because a media that was put into a collection by hand
-- keeps the day it was put there, and a mirrored one falls back to the day
-- it was downloaded.

UPDATE collection_items
   SET created_at = MIN(
         collection_items.created_at,
         (SELECT images.first_seen_at FROM images WHERE images.id = collection_items.image_id)
       )
 WHERE EXISTS (
   SELECT 1
   FROM images
   WHERE images.id = collection_items.image_id
     AND images.first_seen_at IS NOT NULL
     AND images.first_seen_at < collection_items.created_at
 );

-- migrate:down

-- The moment cannot be recovered: it was overwritten.
