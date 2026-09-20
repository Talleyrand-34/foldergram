<!--
  AiAnalyzeButton — opt-in trigger for the AI-analysis plugin.

  Two modes:
    - per-video: :target="'video'" :video-id="N"    → POST /analyze/:imageId
    - per-folder: :target="'folder'" :folder-id="N" → POST /analyze-folder/:folderId

  Props:
    - target: 'video' | 'folder'        (which endpoint to call)
    - videoId?: number                  (required when target='video')
    - folderId?: number                 (required when target='folder')
    - label?: string                    (idle label; falls back to i18n)
    - variant?: 'primary' | 'subtle'    (visual; defaults to 'subtle')

  The button optimistically disables itself on click and surfaces the result
  inline. Errors are shown as a one-line message; the user can retry.
-->

<template>
  <div class="inline-flex flex-col items-start gap-[0.25rem]">
    <button
      type="button"
      class="inline-flex items-center gap-[0.45rem] px-3 py-[0.42rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
      :class="buttonClass"
      :disabled="busy"
      @click="onClick"
    >
      <span
        :class="busy ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-sparkle-16-regular'"
        class="w-[0.95rem] h-[0.95rem]"
        aria-hidden="true"
      />
      <span>{{ buttonLabel }}</span>
    </button>
    <p
      v-if="statusMessage"
      class="m-0 text-[0.74rem] leading-[1.35]"
      :class="statusTone === 'error' ? 'text-[#b42318]' : 'text-muted'"
    >
      {{ statusMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { analyzeFolder, analyzeVideo } from '../api/ai-analysis';

const props = withDefaults(
  defineProps<{
    target: 'video' | 'folder';
    videoId?: number;
    folderId?: number;
    label?: string;
    variant?: 'primary' | 'subtle';
  }>(),
  { variant: 'subtle' },
);

const { t } = useI18n();
const busy = ref(false);
const statusMessage = ref<string | null>(null);
const statusTone = ref<'ok' | 'error'>('ok');

const buttonLabel = computed(() => {
  if (busy.value) {
    return props.target === 'folder'
      ? t('ai.analyze.folder.busy')
      : t('ai.analyze.video.busy');
  }
  if (props.label) return props.label;
  return props.target === 'folder'
    ? t('ai.analyze.folder.idle')
    : t('ai.analyze.video.idle');
});

const buttonClass = computed(() => {
  if (props.variant === 'primary') {
    return 'bg-text text-bg border-text hover:bg-text/90';
  }
  return 'bg-surface-hover text-text border-border hover:bg-border';
});

async function onClick() {
  if (busy.value) return;
  busy.value = true;
  statusMessage.value = null;
  statusTone.value = 'ok';
  try {
    if (props.target === 'video') {
      if (props.videoId === undefined) throw new Error('videoId required');
      const r = await analyzeVideo(props.videoId, false);
      statusMessage.value = r.queued
        ? t('ai.analyze.video.queued')
        : t('ai.analyze.video.alreadyDone', { reason: r.reason ?? '' });
    } else {
      if (props.folderId === undefined) throw new Error('folderId required');
      const r = await analyzeFolder(props.folderId, false);
      const total = r.marked + r.alreadyAnalyzed + r.alreadyQueued;
      statusMessage.value = t('ai.analyze.folder.result', {
        marked: r.marked,
        alreadyAnalyzed: r.alreadyAnalyzed,
        alreadyQueued: r.alreadyQueued,
        total,
      });
    }
  } catch (e) {
    statusMessage.value = e instanceof Error ? e.message : t('ai.analyze.error');
    statusTone.value = 'error';
  } finally {
    busy.value = false;
  }
}
</script>
