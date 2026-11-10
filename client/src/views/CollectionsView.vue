<template>
  <section class="w-[min(100%,58rem)] mx-auto">
    <EmptyState
      v-if="appStore.isLibraryUnavailable"
      :title="t('collections.list.libraryUnavailableTitle')"
      :description="appStore.libraryUnavailableReason"
    />
    <ErrorState
      v-else-if="collectionsStore.error"
      :title="t('collections.list.loadErrorTitle')"
      :message="collectionsStore.error"
    />
    <template v-else>
      <div v-if="collectionsStore.loading" class="card p-8 text-center">
        <p class="text-muted">{{ t('collections.list.loading') }}</p>
      </div>

      <template v-else-if="collectionsStore.items.length > 0">
        <!-- How the grid is ordered. -->
        <div class="flex items-center justify-end gap-3 pb-[0.6rem]">
          <span class="text-[0.78rem] text-muted">{{ t('collections.list.sortLabel') }}</span>
          <SortToggle
            :model-value="appStore.collectionsSort"
            :options="collectionsSortOptions"
            :aria-label="t('collections.list.sortLabel')"
            @update:model-value="setCollectionsSort"
          />
        </div>

        <section class="grid gap-[1px] grid-cols-2 md:grid-cols-3">
        <RouterLink
          v-for="collection in orderedCollections"
          :key="collection.slug"
          class="group relative aspect-square overflow-hidden bg-surface-alt text-white"
          :to="{ name: 'collection', params: { slug: collection.slug } }"
        >
          <div
            v-if="showAllPostsMosaic(collection)"
            class="grid h-full w-full grid-cols-2 grid-rows-2 gap-[1px] bg-black/12"
          >
            <div
              v-for="slotIndex in 4"
              :key="`${collection.slug}-${slotIndex}`"
              class="overflow-hidden bg-[linear-gradient(135deg,#262b31_0%,#111827_100%)]"
            >
              <ResilientImage
                v-if="getPreviewImage(collection, slotIndex - 1)"
                :src="getPreviewImage(collection, slotIndex - 1)?.thumbnailUrl || ''"
                :alt="displayCollectionName(collection)"
                loading="lazy"
                class="h-full w-full object-cover transition-[transform,opacity] duration-220 group-hover:scale-[1.03] group-hover:opacity-90"
              />
            </div>
          </div>
          <ResilientImage
            v-else-if="collection.coverImage"
            :src="collection.coverImage.thumbnailUrl"
            :alt="displayCollectionName(collection)"
            loading="lazy"
            class="h-full w-full object-cover transition-[transform,opacity] duration-220 group-hover:scale-[1.03] group-hover:opacity-90"
          />
          <div v-else class="h-full w-full bg-[linear-gradient(135deg,#262b31_0%,#111827_100%)]"></div>
          <div class="absolute inset-x-0 bottom-0 grid gap-[0.15rem] px-3 py-3 bg-[linear-gradient(180deg,rgba(10,14,24,0)_0%,rgba(10,14,24,0.82)_100%)]">
            <strong class="truncate text-[0.95rem]">{{ displayCollectionName(collection) }}</strong>
            <span class="text-[0.74rem] font-semibold text-white/78">{{ formatPostCount(collection.itemCount) }}</span>
          </div>
          </RouterLink>
        </section>
      </template>

      <EmptyState
        v-else
        :title="t('collections.list.emptyTitle')"
        :description="t('collections.list.emptyDescription')"
      />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import EmptyState from '../components/EmptyState.vue';
import ErrorState from '../components/ErrorState.vue';
import ResilientImage from '../components/ResilientImage.vue';
import SortToggle from '../components/SortToggle.vue';
import { useAppStore } from '../stores/app';
import { useCollectionsStore } from '../stores/collections';
import type { CollectionSummary } from '../types/api';

const appStore = useAppStore();
const collectionsStore = useCollectionsStore();
const { t, locale } = useI18n();

const collectionsSortOptions = computed(() => [
  { value: 'updated', label: t('collections.list.sortUpdated') },
  { value: 'name', label: t('collections.list.sortName') }
]);

/**
 * The collections in the chosen order.
 *
 * The server hands them over in its own order; the operator decides what
 * they should look like.
 */
const orderedCollections = computed(() => {
  const items = collectionsStore.items;

  if (appStore.collectionsSort === 'name') {
    return [...items].sort((left, right) =>
      displayCollectionName(left).localeCompare(displayCollectionName(right), locale.value, {
        sensitivity: 'base'
      })
    );
  }

  // The order is by when the last post JOINED the collection, not by the
  // collection row's own timestamp: a collection that just received a post
  // comes up, and one that has not changed does not.
  const addedAt = (collection: CollectionSummary): number =>
    Date.parse(collection.lastAddedAt ?? collection.updatedAt) || 0;

  return [...items].sort(
    (left, right) => addedAt(right) - addedAt(left) || left.id - right.id
  );
});

function setCollectionsSort(mode: string) {
  if (mode === 'updated' || mode === 'name') {
    appStore.setCollectionsSort(mode);
  }
}

function formatCount(value: number) {
  return new Intl.NumberFormat(locale.value).format(value);
}

function displayCollectionName(collection: CollectionSummary) {
  return collection.isDefault ? t('collections.shared.defaultName') : collection.name;
}

function formatPostCount(value: number) {
  return value === 1
    ? t('collections.shared.postCountOne', { count: formatCount(value) })
    : t('collections.shared.postCountOther', { count: formatCount(value) });
}

function showAllPostsMosaic(collection: CollectionSummary) {
  return collection.isDefault && collection.previewImages.length > 0;
}

function getPreviewImage(collection: CollectionSummary, index: number) {
  return collection.previewImages[index] ?? null;
}

async function loadCollections() {
  if (appStore.isLibraryUnavailable) {
    return;
  }

  await collectionsStore.initialize();
}

onMounted(() => {
  void loadCollections();
});
</script>
