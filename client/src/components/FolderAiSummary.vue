<!--
  FolderAiSummary — AI-derived knowledge for one folder.

  Three states:
    1. Loading   — brief, while the rollup is being fetched
    2. Has data  — summary, top domains, dominant language, coverage
    3. Empty     — "AI hasn't analyzed this folder yet. Trigger an analysis
                    to build the knowledge base."

  Mounted in two places:
    - FolderHeader.vue (default: no empty state — a card on every folder
      page would be noisy when the library is mostly unanalyzed)
    - FolderProfileModal.vue (showEmptyState=true — users editing a folder
      should always see why AI knows or doesn't know something about it)
-->

<template>
  <section
    v-if="loading || rollup"
    :class="[
      'card grid gap-[0.55rem] p-4 border',
      hasData
        ? 'border-border bg-surface-alt'
        : 'border-dashed border-border/60 bg-transparent'
    ]"
  >
    <header class="flex items-center gap-[0.55rem]">
      <span
        :class="hasData ? 'i-fluent-sparkle-16-regular text-accent' : 'i-fluent-sparkle-16-regular text-muted'"
        class="w-[1rem] h-[1rem]"
        aria-hidden="true"
      />
      <span class="text-[0.74rem] font-bold tracking-[0.08em] text-muted uppercase">
        {{ t('ai.folderSummary.heading') }}
      </span>
      <span v-if="loading" class="ml-auto text-[0.72rem] text-muted">{{ t('common.loading') }}</span>
      <span v-else-if="hasData" class="ml-auto text-[0.72rem] text-muted tabular-nums">
        {{ t('ai.folderSummary.coverage', {
          analyzed: rollup!.analyzedCount,
          total: rollup!.videoCount,
        }) }}
      </span>
    </header>

    <p
      v-if="hasData && rollup!.summary"
      class="m-0 text-[0.92rem] leading-[1.45] text-text"
    >
      {{ rollup!.summary }}
    </p>

    <div
      v-if="hasData && (rollup!.topDomains.length > 0 || rollup!.language)"
      class="flex flex-wrap items-center gap-[0.35rem] mt-[0.1rem]"
    >
      <span
        v-for="d in rollup!.topDomains"
        :key="d"
        class="inline-flex items-center px-[0.55rem] py-[0.15rem] text-[0.74rem] font-medium rounded-full border border-border bg-surface text-text"
      >
        {{ d }}
      </span>
      <span
        v-if="rollup!.language"
        class="ml-[0.25rem] text-[0.72rem] font-medium tracking-[0.04em] uppercase text-muted"
      >
        {{ rollup!.language }}
      </span>
    </div>

    <p
      v-else-if="!loading"
      class="m-0 text-[0.86rem] leading-[1.45] text-muted italic"
    >
      {{ t('ai.folderSummary.empty') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { fetchFolderRollup, type FolderRollup } from '../api/ai-analysis';

const props = withDefaults(
  defineProps<{
    folderId: number;
    /** Show the empty-state card when no AI data exists yet (vs. hiding it).
     *  The Edit dialog sets this true so the user always sees the state. */
    showEmptyState?: boolean;
  }>(),
  { showEmptyState: false },
);

const emit = defineEmits<{
  refreshed: [rollup: FolderRollup | null];
}>();

const { t } = useI18n();
const rollup = ref<FolderRollup | null>(null);
const loading = ref(false);

const hasData = computed(() => !!rollup.value && rollup.value.analyzedCount > 0);

async function refresh() {
  if (!Number.isFinite(props.folderId)) return;
  loading.value = true;
  try {
    const r = await fetchFolderRollup(props.folderId);
    rollup.value = r;
    emit('refreshed', r);
  } catch {
    rollup.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
watch(() => props.folderId, refresh);
defineExpose({ refresh });
</script>
