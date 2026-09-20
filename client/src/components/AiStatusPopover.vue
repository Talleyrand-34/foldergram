<!--
  AiStatusPopover — compact AI processing status for the sidebar.

  Triggered by a sparkle button in the sidebar nav. Shows live queue stats
  (polled every 10s), the oldest pending item's age, and a shortcut to the
  full Settings card. Closes on outside click and route change.
-->

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-40"
    @click="$emit('close')"
  />
  <div
    v-if="open"
    class="absolute bottom-[calc(100%+0.45rem)] left-0 w-[19rem] overflow-hidden rounded-[1.4rem] border border-border bg-[color-mix(in_srgb,var(--surface)_96%,var(--bg)_4%)] shadow-[0_28px_70px_rgba(0,0,0,0.24)] z-50 grid gap-[0.6rem] p-[1rem]"
    role="dialog"
    :aria-label="t('ai.popover.title')"
  >
    <header class="flex items-center gap-[0.5rem]">
      <span
        :class="hasPending ? 'i-fluent-sparkle-16-filled text-accent animate-pulse-slow' : 'i-fluent-sparkle-16-regular text-accent'"
        class="w-[1rem] h-[1rem]"
        aria-hidden="true"
      />
      <span class="text-[0.74rem] font-bold tracking-[0.08em] text-muted uppercase">
        {{ t('ai.popover.title') }}
      </span>
      <button
        v-if="!loading"
        type="button"
        class="ml-auto inline-flex items-center justify-center w-6 h-6 rounded-full border-0 bg-transparent text-muted cursor-pointer hover:text-text"
        :aria-label="t('ai.popover.refresh')"
        @click.stop="refresh"
      >
        <span class="i-fluent-arrow-sync-16-regular w-[0.85rem] h-[0.85rem]" aria-hidden="true" />
      </button>
    </header>

    <div v-if="error" class="rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] bg-[rgba(217,48,37,0.08)] px-3 py-2 text-[0.78rem] text-[#b42318]">
      {{ error }}
    </div>

    <div v-else-if="status" class="grid grid-cols-2 gap-[0.45rem]">
      <div class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.6rem] py-[0.45rem]">
        <span class="block text-[0.66rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.status.total') }}
        </span>
        <span class="block mt-[0.05rem] text-[1.05rem] font-medium tabular-nums">
          {{ status.totalVideos }}
        </span>
      </div>
      <div class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.6rem] py-[0.45rem]">
        <span class="block text-[0.66rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.status.ok') }}
        </span>
        <span class="block mt-[0.05rem] text-[1.05rem] font-medium tabular-nums">
          {{ count('ok') }}
        </span>
      </div>
      <div
        :class="pendingTotal > 0 ? 'border-accent/40 text-text' : ''"
        class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.6rem] py-[0.45rem]"
      >
        <span class="block text-[0.66rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.status.pending') }}
        </span>
        <span
          :class="pendingTotal > 0 ? 'text-accent' : 'text-text'"
          class="block mt-[0.05rem] text-[1.05rem] font-medium tabular-nums"
        >
          {{ pendingTotal }}
        </span>
      </div>
      <div class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.6rem] py-[0.45rem]">
        <span class="block text-[0.66rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.status.failed') }}
        </span>
        <span
          :class="count('failed') > 0 ? 'text-[#b42318]' : 'text-text'"
          class="block mt-[0.05rem] text-[1.05rem] font-medium tabular-nums"
        >
          {{ count('failed') }}
        </span>
      </div>
    </div>

    <p
      v-if="status && pendingTotal > 0 && oldestPendingRelative"
      class="m-0 text-[0.78rem] leading-[1.4] text-muted"
    >
      <span class="font-medium text-text">{{ t('ai.popover.oldest') }}</span>
      {{ oldestPendingRelative }}
    </p>
    <p
      v-else-if="status && pendingTotal === 0 && count('ok') > 0"
      class="m-0 text-[0.78rem] leading-[1.4] text-muted"
    >
      {{ t('ai.popover.queueEmpty') }}
    </p>

    <RouterLink
      v-if="canManage"
      :to="{ name: 'settings' }"
      class="inline-flex items-center justify-center gap-[0.4rem] mt-[0.15rem] px-3 py-[0.55rem] rounded-[0.55rem] border border-border bg-surface-hover text-text text-[0.82rem] font-semibold no-underline transition-colors hover:bg-border"
      @click="$emit('close')"
    >
      <span class="i-fluent-arrow-right-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
      {{ t('ai.popover.openSettings') }}
    </RouterLink>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import { fetchAiStatus, type AiStatusSummary } from '../api/ai-analysis';

const props = defineProps<{
  open: boolean;
  canManage: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const POLL_INTERVAL_MS = 10_000;

const status = ref<AiStatusSummary | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const hasPending = computed(() => {
  if (!status.value) return false;
  return (status.value.byStatus.pending ?? 0) + (status.value.byStatus.running ?? 0) > 0;
});

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

function count(key: string): number {
  return status.value?.byStatus[key] ?? 0;
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    status.value = await fetchAiStatus();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('ai.status.error');
  } finally {
    loading.value = false;
  }
}

watch(() => props.open, (open) => {
  if (open) {
    void refresh();
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}, { immediate: true });

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
@keyframes ai-popover-pulse-slow {
  0%, 100% { opacity: 0.9; }
  50% { opacity: 1; }
}
.animate-pulse-slow {
  animation: ai-popover-pulse-slow 1.6s ease-in-out infinite;
}
</style>
