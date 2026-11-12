<!--
  ShareMediaButton — shares the media file itself, not a link to it.

  The browser opens the OS share sheet with the file, so the receiving app
  gets the original media: a photo app receives the photo, a messaging app
  attaches the video.

  The browser only opens the sheet inside a live user gesture, and that
  gesture lives for five seconds, so the button has two states:

    idle      → the first tap fetches the file
    ready     → the file is in memory, the next tap opens the sheet

  When the file is small and fast enough the sheet opens on the first tap.

  The button is not rendered at all when the browser cannot share files (no
  secure context, no Web Share API) or when the file type is one Chromium
  refuses (.mov, .mkv). In that case the download control next to it is the
  way to get the file.
-->

<template>
  <button
    v-if="isSupported"
    type="button"
    :class="buttonClass"
    :aria-label="buttonLabel"
    :title="buttonLabel"
    :aria-busy="state === 'preparing'"
    :disabled="state === 'preparing'"
    @click.stop="handleShare"
  >
    <span :class="iconClass" aria-hidden="true" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { useShareMedia } from '../composables/useShareMedia';
import {
  buildShareFileName,
  guessMimeTypeFromFilename,
  isShareableFileName,
  probeShareSupport
} from '../utils/share-media';
import type { FeedItem } from '../types/api';

const props = withDefaults(
  defineProps<{
    item: FeedItem;
    /** Extra classes for the button, to match the surface it sits in. */
    buttonClass?: string;
  }>(),
  { buttonClass: '' },
);

const { t } = useI18n();

const shareName = buildShareFileName(props.item.filename);
const isSupported =
  isShareableFileName(shareName) &&
  probeShareSupport(guessMimeTypeFromFilename(shareName), shareName);

const { state, isReady, isTooLarge, share } = useShareMedia({
  id: props.item.id,
  filename: props.item.filename,
  mimeType: guessMimeTypeFromFilename(shareName)
});

const buttonLabel = computed(() => {
  if (state.value === 'preparing') return t('share.file.preparing');
  if (state.value === 'ready') return t('share.file.tapToShare');
  if (state.value === 'too-large') return t('share.file.tooLarge');
  if (state.value === 'failed') return t('share.file.failed');
  return t('share.file.action');
});

const iconClass = computed(() => {
  if (state.value === 'preparing') return 'i-fluent-arrow-sync-20-filled animate-spin';
  if (state.value === 'failed' || state.value === 'too-large') return 'i-fluent-share-16-regular opacity-60';
  if (isReady.value) return 'i-fluent-share-16-filled';
  return 'i-fluent-share-16-regular';
});

const buttonClass = computed(() =>
  [
    props.buttonClass,
    'inline-flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer',
    'transition-[opacity,transform,color] duration-180 hover:opacity-72 hover:-translate-y-px',
    'disabled:opacity-45 disabled:cursor-wait disabled:transform-none',
    'text-text'
  ]
    .filter(Boolean)
    .join(' '),
);

async function handleShare(): Promise<void> {
  await share();
}
</script>
