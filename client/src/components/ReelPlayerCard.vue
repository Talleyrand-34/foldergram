<template>
  <article class="reel-player-card">
    <div class="reel-player-card__stage">
      <div
        class="reel-player-card__surface"
        :aria-label="active ? 'Toggle playback' : undefined"
        :role="active ? 'button' : undefined"
        :tabindex="active ? 0 : -1"
        @click="handleSurfaceClick"
        @keydown="handleSurfaceKeydown"
      >
        <media-player
          ref="playerElement"
          class="reel-player-card__player"
          :src.prop="videoSource"
          :title.prop="item.filename"
          :fullscreenOrientation.prop="'none'"
          :playsInline.prop="true"
          :muted.prop="appStore.videoMuted"
          :loop.prop="true"
          :load="playerLoadMode"
          preload="metadata"
        >
          <media-provider />
          <media-poster
            :src.prop="item.thumbnailUrl"
            :alt.prop="item.filename"
          />
          <!-- TikTok-style bottom seek bar -->
          <div class="reel-player-card__seekbar-shell">
            <media-time-slider
              class="reel-player-card__seekbar"
              aria-label="Seek video"
              @click.stop
              @pointerdown.stop
              @pointerup.stop
            >
              <div class="reel-player-card__seekbar-track" />
              <div class="reel-player-card__seekbar-track reel-player-card__seekbar-progress" />
              <div class="reel-player-card__seekbar-track reel-player-card__seekbar-fill" />
              <div class="reel-player-card__seekbar-thumb" />
            </media-time-slider>
          </div>
        </media-player>

        <div
          v-if="showPausedIndicator"
          class="reel-player-card__pause-indicator"
          aria-hidden="true"
        >
          <span class="reel-player-card__pause-icon i-fluent-play-20-filled" />
        </div>

        <div class="reel-player-card__bottom-fade" aria-hidden="true" />

        <div
          class="reel-player-card__overlay"
          :class="{ 'reel-player-card__overlay--visible': active }"
        >
          <div class="reel-player-card__copy">
            <RouterLink
              class="reel-player-card__folder-row reel-player-card__folder-link"
              :to="{ name: 'folder', params: { slug: item.folderSlug } }"
              aria-label="Open folder"
              @click.stop
            >
              <Avatar
                class="reel-player-card__avatar"
                :name="displayFolderTitle"
                :src="folder?.avatarUrl ?? null"
              />
              <div class="reel-player-card__text">
                <strong class="reel-player-card__folder-name">
                  {{ displayFolderTitle }}
                </strong>
                <p class="reel-player-card__folder-description">
                  {{ folderDescription }}
                </p>
              </div>
            </RouterLink>

            <div
              v-if="showCaption"
              class="reel-player-card__caption"
              :class="{ 'reel-player-card__caption--editing': captionEditing }"
            >
              <form
                v-if="captionEditing"
                class="reel-player-card__caption-form"
                @submit.prevent="submitCaption"
                @click.stop
                @pointerdown.stop
              >
                <textarea
                  ref="captionTextarea"
                  v-model="draftCaption"
                  class="reel-player-card__caption-input"
                  maxlength="300"
                  rows="3"
                  :placeholder="t('reels.caption.placeholder')"
                  :disabled="saving"
                />
                <p v-if="captionError" class="reel-player-card__caption-error">
                  {{ captionError }}
                </p>
                <div class="reel-player-card__caption-actions">
                  <button
                    type="button"
                    class="reel-player-card__caption-button"
                    :disabled="saving"
                    @click="cancelEdit"
                  >
                    {{ t('common.cancel') }}
                  </button>
                  <button
                    type="submit"
                    class="reel-player-card__caption-button reel-player-card__caption-button--primary"
                    :disabled="saving"
                  >
                    {{ saving ? t('common.saving') : t('common.save') }}
                  </button>
                </div>
              </form>

              <div
                v-else
                class="reel-player-card__caption-display"
                :class="{ 'reel-player-card__caption-display--expanded': captionExpanded }"
                role="button"
                :tabindex="active ? 0 : -1"
                :aria-expanded="captionExpanded"
                :aria-label="
                  captionExpanded ? t('reels.caption.collapseAria') : t('reels.caption.expandAria')
                "
                @click.stop="handleCaptionClick"
                @pointerdown.stop
                @keydown="handleCaptionKeydown"
              >
                <p class="reel-player-card__caption-text">{{ displayCaption }}</p>

                <span
                  v-if="!captionExpanded"
                  class="reel-player-card__caption-chevron i-fluent-chevron-up-16-regular"
                  aria-hidden="true"
                />

                <div v-else class="reel-player-card__caption-tools">
                  <button
                    v-if="canEditCaption"
                    type="button"
                    class="reel-player-card__caption-tool"
                    :aria-label="t('reels.caption.edit')"
                    :title="t('reels.caption.edit')"
                    @click.stop="beginEdit"
                  >
                    <span class="i-fluent-edit-16-regular" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="reel-player-card__caption-tool"
                    :aria-label="t('reels.caption.collapseAria')"
                    @click.stop="collapseCaption"
                  >
                    <span class="i-fluent-chevron-down-16-regular" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="reel-player-card__controls">
            <div
              v-if="$slots['mobile-action-rail']"
              class="reel-player-card__mobile-actions"
            >
              <slot name="mobile-action-rail" />
            </div>

            <button
              class="reel-player-card__sound-button"
              type="button"
              :aria-label="appStore.videoMuted ? 'Enable sound' : 'Mute sound'"
              @click.stop="toggleSound"
            >
              <span
                class="reel-player-card__sound-icon"
                :class="
                  appStore.videoMuted
                    ? 'i-fluent-speaker-mute-16-regular'
                    : 'i-fluent-speaker-2-16-regular'
                "
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import 'vidstack/bundle';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { PlayerSrc } from 'vidstack';
import type { MediaPlayerElement } from 'vidstack/elements';

import { useImageCaptionEditor } from '../composables/useImageCaptionEditor';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import type { FeedItem, FolderSummary } from '../types/api';
import { resolveDisplayCaption } from '../utils/caption';
import { formatFolderTitle } from '../utils/folder-titles';
import { getOriginalMediaUrl } from '../utils/original-media';
import Avatar from './Avatar.vue';

const props = defineProps<{
  item: FeedItem;
  folder: FolderSummary | null;
  active: boolean;
}>();

const appStore = useAppStore();
const authStore = useAuthStore();
const { t } = useI18n();
const { saving, error: captionError, saveCaption, clearError } = useImageCaptionEditor();
const playerElement = ref<MediaPlayerElement | null>(null);
const isPaused = ref(false);

const captionExpanded = ref(false);
const captionEditing = ref(false);
const draftCaption = ref('');
const captionTextarea = ref<HTMLTextAreaElement | null>(null);

const displayCaption = computed(() => resolveDisplayCaption(props.item));
const hasCustomCaption = computed(
  () => typeof props.item.caption === 'string' && props.item.caption.trim().length > 0
);
const canEditCaption = computed(() => authStore.canManageLibrary);
const showCaption = computed(() => hasCustomCaption.value || canEditCaption.value);

function handleCaptionClick() {
  if (!captionExpanded.value) {
    captionExpanded.value = true;
    return;
  }

  if (canEditCaption.value) {
    beginEdit();
    return;
  }

  captionExpanded.value = false;
}

function handleCaptionKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  event.preventDefault();
  handleCaptionClick();
}

function collapseCaption() {
  captionExpanded.value = false;
}

function beginEdit() {
  if (!canEditCaption.value) {
    return;
  }

  clearError();
  draftCaption.value = displayCaption.value;
  captionExpanded.value = true;
  captionEditing.value = true;
  void nextTick(() => {
    captionTextarea.value?.focus();
  });
}

function cancelEdit() {
  captionEditing.value = false;
  clearError();
}

async function submitCaption() {
  if (saving.value) {
    return;
  }

  try {
    await saveCaption(props.item, draftCaption.value);
    captionEditing.value = false;
  } catch {
    // Failure is surfaced through captionError from the composable.
  }
}
const isUsingOriginalFallback = ref(false);
const playerLoadMode = computed(() => (props.active ? 'eager' : 'visible'));
const currentVideoSrc = computed(() => (isUsingOriginalFallback.value ? getOriginalMediaUrl(props.item.id) : props.item.previewUrl));
const videoSource = computed<PlayerSrc>(() => ({
  src: currentVideoSrc.value,
  type: 'video/mp4'
}));
const showPausedIndicator = computed(() => props.active && isPaused.value);
const displayFolderTitle = computed(() => formatFolderTitle(props.folder ?? props.item, appStore.nestedFolderTitleFormat));
const folderDescription = computed(() => {
  const normalizedFolderPath = props.item.folderPath.replace(/\\/g, '/');
  const folderSegments = normalizedFolderPath.split('/').filter(Boolean);
  const currentFolderName = folderSegments.at(-1);

  return currentFolderName ? `${currentFolderName}/${props.item.filename}` : props.item.filename;
});

let muteSyncToken = 0;
let removePlayerEventListeners: (() => void) | null = null;
let autoplayRetryAttempts = 0;
let autoplayRetryTimer = 0;

const AUTOPLAY_RETRY_DELAY_MS = 140;
const MAX_AUTOPLAY_RETRIES = 3;

function clearAutoplayRetry() {
  if (autoplayRetryTimer !== 0) {
    window.clearTimeout(autoplayRetryTimer);
    autoplayRetryTimer = 0;
  }
}

function resetAutoplayRetry() {
  clearAutoplayRetry();
  autoplayRetryAttempts = 0;
}

function scheduleAutoplayRetry() {
  if (!props.active || autoplayRetryTimer !== 0 || autoplayRetryAttempts >= MAX_AUTOPLAY_RETRIES) {
    return;
  }

  autoplayRetryAttempts += 1;
  autoplayRetryTimer = window.setTimeout(() => {
    autoplayRetryTimer = 0;
    void syncPlayback();
  }, AUTOPLAY_RETRY_DELAY_MS * autoplayRetryAttempts);
}

function switchToOriginalFallback() {
  if (isUsingOriginalFallback.value) {
    return;
  }

  resetAutoplayRetry();
  isUsingOriginalFallback.value = true;
}

function applyPlaybackRate(player: MediaPlayerElement) {
  player.playbackRate = appStore.videoPlaybackRate;
}

function syncMuted(player: MediaPlayerElement, muted: boolean) {
  const token = ++muteSyncToken;
  player.muted = muted;

  requestAnimationFrame(() => {
    if (muteSyncToken === token) {
      muteSyncToken = 0;
    }
  });
}

async function syncPlayback() {
  const player = playerElement.value;
  if (!player) {
    return;
  }

  if (!props.active) {
    resetAutoplayRetry();
    isPaused.value = false;
    void player.pause().catch(() => {
      // Ignore pause rejections before the provider is ready.
    });
    syncMuted(player, appStore.videoMuted);
    return;
  }

  applyPlaybackRate(player);
  syncMuted(player, appStore.videoMuted);

  try {
    await player.play();
    resetAutoplayRetry();
    isPaused.value = false;
    return;
  } catch {
    if (appStore.videoMuted) {
      if (!isUsingOriginalFallback.value && autoplayRetryAttempts >= MAX_AUTOPLAY_RETRIES) {
        switchToOriginalFallback();
        return;
      }

      scheduleAutoplayRetry();
      return;
    }
  }
}

function bindPlayerEventListeners(player: MediaPlayerElement | null) {
  removePlayerEventListeners?.();
  removePlayerEventListeners = null;

  if (!player) {
    return;
  }

  const handleReady = () => {
    applyPlaybackRate(player);
    void syncPlayback();
  };
  const handlePlay = () => {
    isPaused.value = false;
    if (!props.active) {
      void player.pause().catch(() => {
        // Ignore pause rejections before the provider is ready.
      });
    }
  };
  const handlePause = () => {
    isPaused.value = props.active;
  };
  const handleRateChange = () => {
    if (props.active && player.playbackRate !== appStore.videoPlaybackRate) {
      player.playbackRate = appStore.videoPlaybackRate;
    }
  };
  const handleProviderSetup = () => {
    applyPlaybackRate(player);
  };

  player.addEventListener('loaded-metadata', handleReady);
  player.addEventListener('can-play', handleReady);
  player.addEventListener('play', handlePlay);
  player.addEventListener('pause', handlePause);
  player.addEventListener('rate-change', handleRateChange);
  player.addEventListener('provider-setup', handleProviderSetup);

  removePlayerEventListeners = () => {
    player.removeEventListener('loaded-metadata', handleReady);
    player.removeEventListener('can-play', handleReady);
    player.removeEventListener('play', handlePlay);
    player.removeEventListener('pause', handlePause);
    player.removeEventListener('rate-change', handleRateChange);
    player.removeEventListener('provider-setup', handleProviderSetup);
  };

  if (player.hasAttribute('data-can-play')) {
    void syncPlayback();
  }
}

async function toggleSound() {
  const nextMuted = !appStore.videoMuted;
  appStore.setVideoMuted(nextMuted);

  const player = playerElement.value;
  if (!player || !props.active) {
    return;
  }

  syncMuted(player, nextMuted);

  if (player.paused) {
    await syncPlayback();
  }
}

async function handleSurfaceClick(event?: MouseEvent) {
  if (event && isInteractiveTarget(event.target)) {
    return;
  }

  const player = playerElement.value;
  if (!player || !props.active) {
    return;
  }

  if (player.paused) {
    await syncPlayback();
    return;
  }

  isPaused.value = true;
  void player.pause().catch(() => {
    // Ignore pause rejections before the provider is ready.
  });
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('a, button, media-time-slider'));
}

function handleSurfaceKeydown(event: KeyboardEvent) {
  if (isInteractiveTarget(event.target)) {
    return;
  }

  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  event.preventDefault();
  void handleSurfaceClick();
}

watch(
  () => props.active,
  (active) => {
    if (active) {
      resetAutoplayRetry();
    }

    void syncPlayback();
  }
);

watch(
  () => props.item.id,
  () => {
    resetAutoplayRetry();
    isUsingOriginalFallback.value = false;
    isPaused.value = false;
  }
);

watch(
  () => [props.item.id, props.active] as const,
  () => {
    captionExpanded.value = false;
    captionEditing.value = false;
    clearError();
  }
);

watch(
  () => appStore.videoMuted,
  (videoMuted) => {
    const player = playerElement.value;
    if (!player) {
      return;
    }

    syncMuted(player, videoMuted);
  }
);

watch(
  () => appStore.videoPlaybackRate,
  () => {
    const player = playerElement.value;
    if (!player) {
      return;
    }

    applyPlaybackRate(player);
  }
);

watch(playerElement, (player) => {
  bindPlayerEventListeners(player);
});

watch(
  currentVideoSrc,
  () => {
    if (!props.active) {
      return;
    }

    void syncPlayback();
  }
);

onMounted(() => {
  void syncPlayback();
  if (props.active) {
    scheduleAutoplayRetry();
  }
});

onBeforeUnmount(() => {
  clearAutoplayRetry();
  removePlayerEventListeners?.();
  removePlayerEventListeners = null;
  void playerElement.value?.pause().catch(() => {
    // Ignore pause rejections before the provider is ready.
  });
});

defineExpose({ togglePlayback: handleSurfaceClick });
</script>

<style scoped>
.reel-player-card {
  --reel-stage-gap: 0.75rem;
  --reel-stage-inline-gap: 1.25rem;
  --reel-stage-max-width: 24.4rem;
  --reel-stage-max-height: calc(var(--reel-stage-max-width) * 16 / 9);
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: calc(var(--reel-stage-gap) / 2) 0;
}

.reel-player-card__stage {
  position: relative;
  justify-self: center;
  align-self: center;
  width: min(100%, var(--reels-desktop-stage-width, var(--reel-stage-max-width)));
  height: min(
    calc(100% - var(--reel-stage-gap)),
    var(--reels-desktop-stage-height, var(--reel-stage-max-height))
  );
  max-height: 100%;
  max-width: calc(100% - var(--reel-stage-inline-gap));
  aspect-ratio: 9 / 16;
  overflow: hidden;
  border-radius: 0.6rem;
  background: #000;
  box-shadow: none;
}

.reel-player-card__surface {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.reel-player-card__player {
  display: block;
  width: 100%;
  height: 100%;
  color: #fff;
  background: #000;
}

.reel-player-card__player :deep(media-provider),
.reel-player-card__player :deep(media-poster),
.reel-player-card__player :deep(video),
.reel-player-card__player :deep(img) {
  display: block;
  width: 100%;
  height: 100%;
}

.reel-player-card__player :deep(video),
.reel-player-card__player :deep(img) {
  object-fit: contain;
  background: #000;
}

.reel-player-card__pause-indicator {
  position: absolute;
  inset: 50% auto auto 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 4.25rem;
  height: 4.25rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.48);
  color: #fff;
  pointer-events: none;
  transform: translate(-50%, -50%);
  z-index: 1;
}

.reel-player-card__pause-icon {
  width: 1.45rem;
  height: 1.45rem;
}

.reel-player-card__bottom-fade {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  height: 38%;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.76) 100%);
  pointer-events: none;
}

.reel-player-card__overlay {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 1rem 1rem;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}

.reel-player-card__overlay--visible {
  opacity: 1;
  pointer-events: auto;
}

.reel-player-card__copy {
  min-width: 0;
  max-width: calc(100% - 3.3rem);
}

.reel-player-card__controls {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: flex-end;
  justify-content: flex-end;
}

.reel-player-card__mobile-actions {
  display: none;
}

.reel-player-card__folder-row {
  display: flex;
  align-items: center;
  gap: 0.78rem;
  min-width: 0;
  width: 100%;
}

.reel-player-card__folder-link {
  color: inherit;
  text-decoration: none;
}

.reel-player-card__text {
  flex: 1 1 auto;
  min-width: 0;
}

.reel-player-card__folder-link:hover .reel-player-card__folder-name,
.reel-player-card__folder-link:focus-visible .reel-player-card__folder-name {
  text-decoration: underline;
}

.reel-player-card__folder-link:focus-visible {
  outline: 2px solid rgba(255, 255, 255, 0.72);
  outline-offset: 0.25rem;
  border-radius: 0.85rem;
}

.reel-player-card__avatar {
  width: 2.4rem;
  height: 2.4rem;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.reel-player-card__folder-name {
  display: block;
  overflow: hidden;
  font-size: 0.96rem;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.98);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reel-player-card__folder-description {
  display: block;
  margin: 0.18rem 0 0;
  overflow: hidden;
  font-size: 0.8rem;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.72);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reel-player-card__caption {
  margin-top: 0.55rem;
  pointer-events: auto;
}

.reel-player-card__caption-display {
  position: relative;
  display: block;
  width: 100%;
  padding: 0.35rem 1.9rem 0.35rem 0;
  border: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.92);
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.reel-player-card__caption-display--expanded {
  padding: 0.55rem 0.7rem;
  margin-left: -0.7rem;
  margin-right: -0.4rem;
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}

.reel-player-card__caption-text {
  display: -webkit-box;
  margin: 0;
  max-height: 1.4em;
  overflow: hidden;
  font-size: 0.85rem;
  line-height: 1.4;
  color: rgba(255, 255, 255, 0.92);
  white-space: pre-wrap;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  transition: max-height 0.28s cubic-bezier(0.32, 0.72, 0, 1);
}

.reel-player-card__caption-display--expanded .reel-player-card__caption-text {
  max-height: 40vh;
  overflow-y: auto;
  -webkit-line-clamp: unset;
}

.reel-player-card__caption-chevron {
  position: absolute;
  top: 50%;
  right: 0.2rem;
  width: 0.9rem;
  height: 0.9rem;
  color: rgba(255, 255, 255, 0.62);
  pointer-events: none;
  transform: translateY(-50%);
}

.reel-player-card__caption-tools {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  display: inline-flex;
  gap: 0.25rem;
}

.reel-player-card__caption-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: rgba(230, 233, 239, 0.2);
  color: rgba(255, 255, 255, 0.95);
  cursor: pointer;
  transition: background-color 0.18s ease;
}

.reel-player-card__caption-tool:hover {
  background: rgba(230, 233, 239, 0.32);
}

.reel-player-card__caption-tool span {
  width: 0.95rem;
  height: 0.95rem;
}

.reel-player-card__caption-form {
  display: grid;
  gap: 0.5rem;
  padding: 0.6rem;
  margin-left: -0.7rem;
  margin-right: -0.4rem;
  border-radius: 0.6rem;
  background: rgba(0, 0, 0, 0.52);
  backdrop-filter: blur(2px);
}

.reel-player-card__caption-input {
  width: 100%;
  min-height: 4.5rem;
  max-height: 30vh;
  padding: 0.5rem 0.6rem;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font: inherit;
  font-size: 0.85rem;
  line-height: 1.4;
  resize: vertical;
}

.reel-player-card__caption-input:focus {
  border-color: rgba(255, 255, 255, 0.5);
  outline: none;
}

.reel-player-card__caption-input::placeholder {
  color: rgba(255, 255, 255, 0.5);
}

.reel-player-card__caption-error {
  margin: 0;
  font-size: 0.78rem;
  color: #ff8a80;
}

.reel-player-card__caption-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.reel-player-card__caption-button {
  min-height: 2rem;
  padding: 0.35rem 0.9rem;
  border: 0;
  border-radius: 0.55rem;
  background: rgba(230, 233, 239, 0.2);
  color: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.reel-player-card__caption-button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.reel-player-card__caption-button--primary {
  background: #fff;
  color: #000;
}

.reel-player-card__sound-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: rgba(230, 233, 239, 0.22);
  color: rgba(255, 255, 255, 0.96);
  cursor: pointer;
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    opacity 0.18s ease,
    transform 0.15s ease;
}

.reel-player-card__sound-button:hover {
  color: #fff;
  background: rgba(230, 233, 239, 0.3);
  opacity: 0.9;
  transform: translateY(-1px);
}

.reel-player-card__sound-icon {
  width: 1rem;
  height: 1rem;
}

@media (max-width: 768px) {
  .reel-player-card {
    --reel-stage-gap: 0;
    padding: 0;
  }

  .reel-player-card__stage {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border-radius: 0;
  }

  .reel-player-card__overlay {
    display: block;
    padding: 0 4.85rem 1rem 1rem;
  }

  .reel-player-card__pause-indicator {
    width: 3.9rem;
    height: 3.9rem;
  }

  .reel-player-card__copy {
    max-width: 100%;
  }

  .reel-player-card__controls {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    display: grid;
    gap: 0.78rem;
    align-items: end;
    justify-items: center;
  }

  .reel-player-card__mobile-actions {
    display: block;
  }

  .reel-player-card__avatar {
    width: 2.15rem;
    height: 2.15rem;
  }

  .reel-player-card__sound-button {
    width: 1.9rem;
    height: 1.9rem;
  }
}

/* ── Bottom seek bar ──────────────────────────────────────── */

.reel-player-card__seekbar-shell {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  z-index: 4;
  pointer-events: none;
}

.reel-player-card__seekbar {
  position: relative;
  display: block;
  width: 100%;
  /* tall hit-target for comfortable scrubbing */
  height: 1.25rem;
  cursor: pointer;
  touch-action: none;
  pointer-events: auto;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

/* shared track base */
.reel-player-card__seekbar-track {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  top: auto;
  height: 2.5px;
  border-radius: 0;
  transform: none;
  transition: height 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

/* expand on hover/drag */
.reel-player-card__seekbar-shell:hover .reel-player-card__seekbar-track,
.reel-player-card__seekbar[data-active] .reel-player-card__seekbar-track,
.reel-player-card__seekbar[data-dragging] .reel-player-card__seekbar-track {
  height: 6px;
}

/* track layers */
.reel-player-card__seekbar .reel-player-card__seekbar-track:first-child {
  z-index: 0;
  background: rgba(255, 255, 255, 0.22);
}

.reel-player-card__seekbar-progress {
  z-index: 1;
  width: var(--slider-progress, 0%);
  background: rgba(255, 255, 255, 0.40);
  will-change: width;
}

.reel-player-card__seekbar-fill {
  z-index: 2;
  width: var(--slider-fill, 0%);
  background: #fff;
  will-change: width;
}

/* thumb — only visible on hover/drag/focus */
.reel-player-card__seekbar-thumb {
  position: absolute;
  bottom: 0;
  top: auto;
  left: var(--slider-fill, 0%);
  z-index: 3;
  width: 0.78rem;
  height: 0.78rem;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32);
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 50%);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
  will-change: left;
}

.reel-player-card__seekbar-shell:hover .reel-player-card__seekbar-thumb,
.reel-player-card__seekbar[data-active] .reel-player-card__seekbar-thumb,
.reel-player-card__seekbar[data-dragging] .reel-player-card__seekbar-thumb,
.reel-player-card__seekbar[data-focus] .reel-player-card__seekbar-thumb,
.reel-player-card__seekbar:focus-visible .reel-player-card__seekbar-thumb {
  opacity: 1;
  transform: translate(-50%, 40%);
}

.reel-player-card__seekbar[data-focus] .reel-player-card__seekbar-track,
.reel-player-card__seekbar:focus-visible .reel-player-card__seekbar-track {
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.16);
}
</style>
