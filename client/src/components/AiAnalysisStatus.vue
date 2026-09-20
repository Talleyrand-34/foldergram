<!--
  AiAnalysisStatus — live status of the AI analysis plugin.

  Polls GET /api/plugins/ai-analysis/status every 10s (configurable). Shows:
    - total videos in the library
    - breakdown by status (ok / pending / running / failed / skipped / unanalyzed)
    - when the oldest pending item was queued
    - a "Refresh now" button for immediate updates

  No manual refresh button is wired to the server; the user triggers
  analysis per-folder/per-post from the buttons added in commit cda2145.
  This component is purely observational.
-->

<template>
  <section class="card p-5 md:p-6 flex flex-col gap-4">
    <header class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
      <div>
        <span class="eyebrow">{{ t('ai.status.eyebrow') }}</span>
        <h2 class="m-0 text-[1.1rem]">{{ t('ai.status.title') }}</h2>
        <p class="m-0 mt-[0.15rem] text-muted text-[0.86rem]">{{ t('ai.status.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center justify-center self-start px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
        @click="refresh"
      >
        <span :class="loading ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-sync-16-regular'" class="w-[0.95rem] h-[0.95rem] mr-[0.4rem]" aria-hidden="true" />
        {{ t('ai.status.refresh') }}
      </button>
    </header>

    <div v-if="error" class="px-3 py-2 rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] text-[0.86rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]">
      {{ error }}
    </div>

    <div v-else-if="status" class="grid grid-cols-2 sm:grid-cols-4 gap-[0.75rem]">
      <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
        <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">{{ t('ai.status.total') }}</span>
        <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">{{ status.totalVideos }}</span>
        <span class="block text-[0.74rem] text-muted">{{ t('ai.status.videos') }}</span>
      </div>
      <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
        <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">{{ t('ai.status.ok') }}</span>
        <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">{{ count('ok') }}</span>
        <span class="block text-[0.74rem] text-muted">{{ t('ai.status.analyzed') }}</span>
      </div>
      <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
        <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">{{ t('ai.status.pending') }}</span>
        <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">{{ pendingTotal }}</span>
        <span class="block text-[0.74rem] text-muted">
          <template v-if="oldestPendingRelative">{{ oldestPendingRelative }}</template>
          <template v-else>{{ t('ai.status.noQueue') }}</template>
        </span>
      </div>
      <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
        <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">{{ t('ai.status.failed') }}</span>
        <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">{{ count('failed') }}</span>
        <span class="block text-[0.74rem] text-muted">{{ t('ai.status.failures') }}</span>
      </div>
    </div>

    <p v-if="status && status.totalVideos > 0" class="m-0 text-[0.78rem] text-muted">
      {{ t('ai.status.hint') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { fetchAiStatus, type AiStatusSummary } from '../api/ai-analysis';

const { t, locale } = useI18n();
const POLL_INTERVAL_MS = 10_000;

const status = ref<AiStatusSummary | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const lastUpdated = ref<number | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    status.value = await fetchAiStatus();
    lastUpdated.value = Date.now();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('ai.status.error');
  } finally {
    loading.value = false;
  }
}

function count(key: string): number {
  return status.value?.byStatus[key] ?? 0;
}

const pendingTotal = computed(() => {
  if (!status.value) return 0;
  return (status.value.byStatus.pending ?? 0) + (status.value.byStatus.running ?? 0);
});

const oldestPendingRelative = computed(() => {
  if (!status.value?.oldestPendingAt) return null;
  const ts = Date.parse(status.value.oldestPendingAt);
  if (Number.isNaN(ts)) return null;
  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 60) return t('ai.status.queuedJustNow');
  if (diffSec < 3600) return t('ai.status.queuedMinutesAgo', { n: Math.floor(diffSec / 60) });
  return t('ai.status.queuedHoursAgo', { n: Math.floor(diffSec / 3600) });
});

onMounted(() => {
  void refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>
