import type { FeedItem, FolderSummary } from '../types/api';

const RECENT_ACTIVITY_WINDOW_MS = 1000 * 60 * 60 * 24 * 60;

export function rankExploreItems(
  items: FeedItem[],
  folders: FolderSummary[],
  likedCountByFolder: Map<string, number>,
  recentOpenedFolderSlugs: string[],
  lastOpenedFolderSlug: string | null,
  now = Date.now()
): FeedItem[] {
  if (items.length <= 1) {
    return items;
  }

  const folderBySlug = new Map(folders.map((folder) => [folder.slug, folder] as const));
  const recentOrder = new Map(recentOpenedFolderSlugs.map((slug, index) => [slug, index] as const));

  return [...items].sort((left, right) => {
    const scoreComparison = compareNumbers(
      getExploreItemScore(right, folderBySlug, likedCountByFolder, recentOrder, lastOpenedFolderSlug, now),
      getExploreItemScore(left, folderBySlug, likedCountByFolder, recentOrder, lastOpenedFolderSlug, now)
    );

    if (scoreComparison !== 0) {
      return scoreComparison;
    }

    return compareNumbers(right.sortTimestamp, left.sortTimestamp) || compareNumbers(right.id, left.id);
  });
}

/**
 * Order the explore grid by when the content was last touched.
 *
 * The plain "newest first" — the counterpart to the mixed ranking, which
 * reads as random because it mixes recency, likes, size and the folders that
 * were opened recently.
 */
export function sortExploreItemsByUpdated(items: FeedItem[]): FeedItem[] {
  return [...items].sort(
    (left, right) =>
      compareNumbers(right.sortTimestamp, left.sortTimestamp) ||
      compareNumbers(right.id, left.id)
  );
}

/**
 * A stable shuffle.
 *
 * The order is random, but it does not change while the page is open — the
 * items would otherwise jump around under the cursor. The seed is what makes
 * it random: a new seed is a new order, the same seed is the same order.
 */
export function shuffleWithSeed<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0 || 1;

  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967295;
  };

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const held = result[index];
    result[index] = result[swap];
    result[swap] = held;
  }

  return result;
}

export function searchFolders(folders: FolderSummary[], query: string): FolderSummary[] {
  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);

  return folders
    .map((folder) => {
      const name = normalizeText(folder.name);
      const slug = normalizeText(folder.slug);
      const breadcrumb = normalizeText(folder.breadcrumb ?? '');
      const folderPath = normalizeText(folder.folderPath);
      const haystack = `${name} ${slug} ${breadcrumb} ${folderPath}`.trim();

      if (!queryTokens.every((token) => haystack.includes(token))) {
        return null;
      }

      let score = 0;

      if (name === normalizedQuery) {
        score += 90;
      } else if (name.startsWith(normalizedQuery)) {
        score += 48;
      } else if (name.includes(normalizedQuery)) {
        score += 32;
      }

      if (slug === normalizedQuery) {
        score += 42;
      } else if (slug.startsWith(normalizedQuery)) {
        score += 24;
      } else if (slug.includes(normalizedQuery)) {
        score += 16;
      }

      if (breadcrumb.includes(normalizedQuery)) {
        score += 12;
      }

      if (folderPath.includes(normalizedQuery)) {
        score += 10;
      }

      for (const token of queryTokens) {
        if (name.startsWith(token)) {
          score += 10;
        } else if (name.includes(token)) {
          score += 5;
        }

        if (slug.startsWith(token)) {
          score += 6;
        }
      }

      score += normalizeLogarithmicValue(folder.imageCount, 50) * 6;
      score += getRecentActivityScore(folder.latestImageMtimeMs, Date.now()) * 4;

      return {
        folder,
        score
      };
    })
    .filter((entry): entry is { folder: FolderSummary; score: number } => entry !== null)
    .sort((left, right) => {
      const scoreComparison = compareNumbers(right.score, left.score);
      if (scoreComparison !== 0) {
        return scoreComparison;
      }

      const imageCountComparison = compareNumbers(right.folder.imageCount, left.folder.imageCount);
      if (imageCountComparison !== 0) {
        return imageCountComparison;
      }

      const recentComparison = compareNumbers(right.folder.latestImageMtimeMs ?? 0, left.folder.latestImageMtimeMs ?? 0);
      if (recentComparison !== 0) {
        return recentComparison;
      }

      return left.folder.name.localeCompare(right.folder.name, undefined, { sensitivity: 'base' });
    })
    .map((entry) => entry.folder);
}

function getExploreItemScore(
  item: FeedItem,
  folderBySlug: Map<string, FolderSummary>,
  likedCountByFolder: Map<string, number>,
  recentOrder: Map<string, number>,
  lastOpenedFolderSlug: string | null,
  now: number
): number {
  const folder = folderBySlug.get(item.folderSlug);
  const recentOrderIndex = recentOrder.get(item.folderSlug);
  const recentOpenBoost =
    typeof recentOrderIndex === 'number' ? Math.max(0, 1 - recentOrderIndex / Math.max(1, recentOrder.size)) : 0;
  const lastOpenedBoost = lastOpenedFolderSlug === item.folderSlug ? 1 : 0;
  const folderRecencyScore = getRecentActivityScore(folder?.latestImageMtimeMs ?? item.sortTimestamp, now);
  const likeScore = normalizeLogarithmicValue(likedCountByFolder.get(item.folderSlug) ?? 0, 8);
  const imageVolumeScore = normalizeLogarithmicValue(folder?.imageCount ?? 0, 40);
  const contentFreshnessScore = getRecentActivityScore(item.sortTimestamp, now);

  return (
    folderRecencyScore * 0.33 +
    contentFreshnessScore * 0.24 +
    likeScore * 0.2 +
    imageVolumeScore * 0.11 +
    recentOpenBoost * 0.08 +
    lastOpenedBoost * 0.04 +
    getItemJitter(item.id) * 0.01
  );
}

function getRecentActivityScore(timestampMs: number | null | undefined, now: number): number {
  if (!timestampMs) {
    return 0;
  }

  const ageMs = Math.max(0, now - timestampMs);
  return Math.max(0, 1 - ageMs / RECENT_ACTIVITY_WINDOW_MS);
}

function normalizeLogarithmicValue(value: number, cap: number): number {
  if (value <= 0) {
    return 0;
  }

  return Math.min(1, Math.log(value + 1) / Math.log(cap));
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function getItemJitter(id: number): number {
  let state = id >>> 0;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;

  return (state >>> 0) / 4294967295;
}

function compareNumbers(left: number, right: number): number {
  if (left === right) {
    return 0;
  }

  return left > right ? 1 : -1;
}
