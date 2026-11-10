/**
 * Choosing which Instagram saved collections a mirror covers.
 *
 * Pure logic, kept apart from `collectionMirror.ts` so it can be reasoned
 * about (and tested) without touching the database.
 */

import type { InstagramCollection } from "./instagramCollections.js";

/**
 * Which collections a mirror covers.
 *
 * `null` means every collection. A selection matches on the Instagram id
 * (stable across renames) or on the name (case-insensitive), so a selection
 * stored before a collection was renamed still resolves.
 */
export interface MirrorSelection {
  ids?: string[];
  names?: string[];
}

/**
 * Narrow a list of Instagram collections down to the selected ones.
 *
 * Instagram's catch-all "All posts" pseudo-collection is never mirrorable:
 * it holds every saved post, not a sub-collection.
 */
export function selectCollections(
  collections: InstagramCollection[],
  selection: MirrorSelection | null
): InstagramCollection[] {
  const candidates = collections.filter((collection) => !collection.isAuto);
  if (!selection) return candidates;

  const ids = new Set((selection.ids ?? []).filter((id) => id.trim() !== ""));
  const names = new Set(
    (selection.names ?? [])
      .filter((name) => name.trim() !== "")
      .map((name) => name.trim().toLocaleLowerCase())
  );

  // An empty selection matches nothing — mirroring everything would be the
  // opposite of what an empty "only these collections" list means.
  if (ids.size === 0 && names.size === 0) return [];

  return candidates.filter(
    (collection) =>
      ids.has(collection.id) ||
      names.has(collection.name.trim().toLocaleLowerCase())
  );
}

/**
 * A human-readable summary of a selection, for the job log and error
 * messages.
 */
export function describeSelection(selection: MirrorSelection | null): string {
  if (!selection) return "all collections";

  const names = (selection.names ?? []).filter((name) => name.trim() !== "");
  if (names.length > 0) return names.join(", ");

  const ids = (selection.ids ?? []).filter((id) => id.trim() !== "");
  return ids.length > 0 ? ids.join(", ") : "no collection";
}
