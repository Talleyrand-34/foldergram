<!--
  AiAnalyzeIconButton — shared, discrete AI analysis trigger.

  Used everywhere a video is shown: PostViewer sidebar actions, ReelPlayerCard,
  FeedCard, ExploreGrid card overlay. Same icon, same state, same tooltip
  language across every surface.

  Props:
    - videoId: number        (required)
    - mode: 'icon' | 'card-overlay'
        icon         — bare icon for use inside existing action rows
                       (e.g. PostViewer sidebar). No background.
        card-overlay — small icon with a circular translucent background,
                       designed for absolute positioning over a card
                       thumbnail. Always visible, but small.

  Visual states (identical for both modes):
    idle      →  sparkle outlined, neutral color
    queued    →  sparkle outlined, muted color (slightly dimmer)
    running   →  spinner filled, neutral color (animation indicates busy)
    done      →  sparkle filled, accent color (filled variant signals done)
    failed    →  sparkle outlined, red color

  Loads the per-video AI status on mount and on videoId change. After
  triggering an analysis, optimistically sets state to 'queued' and
  re-reads the status after 1.5 s and 8 s to pick up the actual outcome.
-->

<template>
  <button
    type="button"
    :class="buttonClass"
    :aria-label="buttonLabel"
    :title="buttonLabel"
    :disabled="aiBusy || aiState === 'running'"
    @click.stop="triggerAiAnalysis"
  >
    <span :class="iconClass" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { analyzeVideo, fetchImageAiStatus, type AiStatus } from '../api/ai-analysis';

type AiButtonState = 'idle' | 'pending' | 'running' | 'done' | 'failed';

const props = withDefaults(
  defineProps<{
    videoId: number;
    mode?: 'icon' | 'card-overlay';
  }>(),
  { mode: 'icon' },
);

const { t } = useI18n();

const aiState = ref<AiButtonState>('idle');
const aiBusy = ref(false);
const aiBusyRef = ref<number | null>(null);
let statusTimer: ReturnType<typeof setTimeout> | null = null;

const buttonLabel = computed(() => {
  if (aiBusy.value) return t('ai.analyze.video.busy');
  switch (aiState.value) {
    case 'pending': return t('ai.analyze.video.state.queued');
    case 'running': return t('ai.analyze.video.state.running');
    case 'done':    return t('ai.analyze.video.state.done');
    case 'failed':  return t('ai.analyze.video.state.failed');
    default:        return t('ai.analyze.video.idle');
  }
});

const iconClass = computed(() => {
  if (aiBusy.value) return 'i-fluent-arrow-sync-20-filled animate-spin';
  if (aiState.value === 'running') return 'i-fluent-arrow-sync-20-filled animate-spin';
  if (aiState.value === 'done')    return 'i-fluent-sparkle-20-filled';
  return 'i-fluent-sparkle-20-regular';
});

const buttonClass = computed(() => {
  const color =
    aiState.value === 'pending' ? 'text-muted' :
    aiState.value === 'done'    ? 'text-accent' :
    aiState.value === 'failed'  ? 'text-[#b42318]' :
    'text-text';
  if (props.mode === 'card-overlay') {
    return [
      'inline-flex items-center justify-center w-7 h-7 rounded-full border-0 cursor-pointer',
      'bg-black/55 text-white hover:bg-black/75 transition-[opacity,transform,color] duration-180',
      'disabled:cursor-not-allowed disabled:opacity-60',
      'backdrop-blur-[2px]'
    ].join(' ');
  }
  // icon mode: matches viewer__sidebar-action style so it sits naturally
  // next to Set as cover / Download / Open original.
  return [
    'viewer__sidebar-action inline-flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer',
    'transition-[opacity,transform,color] duration-180 hover:opacity-72 hover:-translate-y-px',
    'disabled:opacity-45 disabled:cursor-wait disabled:transform-none',
    color
  ].join(' ');
});

function mapServerStatus(s: AiStatus | null): AiButtonState {
  if (s === 'pending') return 'pending';
  if (s === 'running') return 'running';
  if (s === 'ok') return 'done';
  if (s === 'failed') return 'failed';
  return 'idle';
}

async function loadAiStatus() {
  const id = props.videoId;
  if (!Number.isFinite(id)) return;
  try {
    const res = await fetchImageAiStatus(id);
    if (aiBusyRef.value !== null && aiBusyRef.value === id) return;
    aiState.value = mapServerStatus(res?.status ?? null);
  } catch {
    // Silent: keep previous state.
  }
}

function clearStatusTimer() {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
}

watch(
  () => props.videoId,
  (id) => {
    if (Number.isFinite(id)) {
      clearStatusTimer();
      aiState.value = 'idle';
      void loadAiStatus();
    }
  },
  { immediate: true },
);

async function triggerAiAnalysis() {
  if (aiBusy.value) return;
  const id = props.videoId;
  if (!Number.isFinite(id)) return;
  aiBusy.value = true;
  aiBusyRef.value = id;
  aiState.value = 'pending';
  clearStatusTimer();
  try {
    await analyzeVideo(id, false);
    // Re-read after short delays to pick up the actual outcome (the worker
    // processes the row asynchronously).
    statusTimer = setTimeout(() => void loadAiStatus(), 1500);
    setTimeout(() => void loadAiStatus(), 8000);
  } catch {
    aiState.value = 'failed';
  } finally {
    aiBusy.value = false;
    aiBusyRef.value = null;
  }
}
</script>

<style scoped>
/* The card-overlay mode applies a small backdrop circle. The icon mode
   inherits its visual weight from .viewer__sidebar-action so it lines up
   with neighboring buttons in PostViewer's actions row. */
</style>
