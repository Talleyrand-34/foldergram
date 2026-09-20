<!--
  FolderAiSummary — discreet AI-derived knowledge for one folder.

  Renders the rollup produced by the ai-analysis plugin:
    - stitched summary of the top-N domains' example summaries
    - top domains (chips)
    - dominant language
    - "X of Y videos analyzed"

  Fetches /api/plugins/ai-analysis/folder/:id/rollup on mount and when the
  folder id changes. Re-emits 'refresh' on success so callers can chain
  further actions (e.g. re-fetching the folder profile right after).

  Renders nothing if the folder has no rollup yet (zero analyzed videos).
-->

<template>
  <section
    v-if="rollup && rollup.analyzedCount > 0"
    class="card grid gap-[0.55rem] p-4 border border-border bg-surface-alt"
  >
    <header class="flex items-center gap-[0.55rem]">
      <span class="i-fluent-sparkle-16-regular w-[1rem] h-[1rem] text-accent" aria-hidden="true" />
      <span class="text-[0.74rem] font-bold tracking-[0.08em] text-muted uppercase">
        {{ t('ai.folderSummary.heading') }}
      </span>
      <span class="ml-auto text-[0.72rem] text-muted tabular-nums">
        {{ t('ai.folderSummary.coverage', {
          analyzed: rollup.analyzedCount,
          total: rollup.videoCount,
        }) }}
      </span>
    </header>

    <p
      v-if="rollup.summary"
      class="m-0 text-[0.92rem] leading-[1.45] text-text"
    >
      {{ rollup.summary }}
    </p>

    <div
      v-if="rollup.topDomains.length > 0 || rollup.language"
      class="flex flex-wrap items-center gap-[0.35rem] mt-[0.1rem]"
    >
      <span
        v-for="d in rollup.topDomains"
        :key="d"
        class="inline-flex items-center px-[0.55rem] py-[0.15rem] text-[0.74rem] font-medium rounded-full border border-border bg-surface text-text"
      >
        {{ d }}
      </span>
      <span
        v-if="rollup.language"
        class="ml-[0.25rem] text-[0.72rem] font-medium tracking-[0.04em] uppercase text-muted"
      >
        {{ rollup.language }}
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { fetchFolderRollup, type FolderRollup } from '../api/ai-analysis';

const props = defineProps<{
  folderId: number;
}>();

const emit = defineEmits<{
  refreshed: [rollup: FolderRollup | null];
}>();

const { t } = useI18n();
const rollup = ref<FolderRollup | null>(null);

async function refresh() {
  if (!Number.isFinite(props.folderId)) return;
  try {
    const r = await fetchFolderRollup(props.folderId);
    rollup.value = r;
    emit('refreshed', r);
  } catch {
    // Silent: the section won't render, which is fine.
    rollup.value = null;
  }
}

onMounted(refresh);

watch(() => props.folderId, refresh);
</script>
