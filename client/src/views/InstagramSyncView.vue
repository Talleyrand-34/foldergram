<!--
  InstagramSyncView — dedicated panel for the instagram-sync plugin.

  One screen, three blocks:
    1. Status — gallery-dl version, cookie state, archive size, schedule
    2. Last run — status, counters, duration, error
    3. Actions — update gallery-dl / run now / check / upload cookie file

  The status is polled every 10 s while the view is mounted; the interval is
  cleared on unmount. `GET /status` does not hit PyPI, so the latest published
  gallery-dl version comes from `GET /gallery-dl/check`, which is fetched once
  on mount and on demand via the "Check for updates" button.
-->

<template>
  <section class="w-[min(100%,72rem)] mx-auto flex flex-col gap-[1.2rem]">
    <header class="flex items-end justify-between gap-4 pb-[0.8rem] max-sm:flex-col max-sm:items-start">
      <div>
        <span class="eyebrow">{{ t('instagramSync.eyebrow') }}</span>
        <h1 class="mt-[0.15rem] mb-0 text-[clamp(1.55rem,2.4vw,2rem)] font-medium tracking-[-0.04em]">
          {{ t('instagramSync.title') }}
        </h1>
        <p class="m-0 text-muted">{{ t('instagramSync.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="inline-flex items-center justify-center self-start px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
        @click="refresh"
      >
        <span
          :class="loading ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-sync-16-regular'"
          class="w-[0.95rem] h-[0.95rem] mr-[0.4rem]"
          aria-hidden="true"
        />
        {{ t('instagramSync.refresh') }}
      </button>
    </header>

    <div
      v-if="error"
      role="alert"
      class="px-3 py-2 rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] text-[0.86rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]"
    >
      {{ error }}
    </div>

    <div
      v-if="notice"
      role="status"
      class="px-3 py-2 rounded-[0.55rem] border border-[rgba(24,119,242,0.2)] text-[0.86rem] text-accent-strong bg-[rgba(24,119,242,0.08)]"
    >
      {{ notice }}
    </div>

    <section class="card p-5 md:p-6 flex flex-col gap-4">
      <h2 class="m-0 text-[1.05rem]">{{ t('instagramSync.status.heading') }}</h2>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-[0.75rem]">
        <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.status.galleryDl') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">
            {{ galleryDlInstalled }}
          </span>
          <span class="block text-[0.74rem] text-muted">
            {{ t('instagramSync.status.latest') }}: {{ galleryDlLatest }}
          </span>
          <span
            v-if="galleryDlLatestKnown"
            class="block text-[0.74rem]"
            :class="galleryDlUpdateAvailable ? 'text-accent-strong' : 'text-muted'"
          >
            {{ galleryDlUpdateAvailable ? t('instagramSync.status.updateAvailable') : t('instagramSync.status.upToDate') }}
          </span>
          <span class="block text-[0.74rem] text-muted">
            {{ t('instagramSync.status.minRequired') }}: {{ galleryDlMinRequired }}
          </span>
        </div>

        <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.status.cookie') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.05rem] font-medium">
            {{ cookieState }}
          </span>
          <span class="block text-[0.74rem] text-muted">
            {{ cookieUpdatedAt }}
          </span>
        </div>

        <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.status.archive') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">
            {{ archiveEntries }}
          </span>
          <span class="block text-[0.74rem] text-muted">{{ archiveSize }}</span>
        </div>

        <div class="rounded-[0.7rem] border border-border bg-surface-alt px-3 py-[0.7rem]">
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.status.schedule') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.05rem] font-medium">{{ scheduleState }}</span>
          <span class="block text-[0.74rem] text-muted">{{ nextRun }}</span>
          <span class="block text-[0.74rem] text-muted">{{ t('instagramSync.status.cron', { cron }) }}</span>
          <span class="block text-[0.74rem] text-muted break-all">{{ sourceUrl }}</span>
        </div>
      </div>
    </section>

    <section class="card p-5 md:p-6 flex flex-col gap-3">
      <h2 class="m-0 text-[1.05rem]">{{ t('instagramSync.lastRun.heading') }}</h2>
      <p v-if="!lastRun" class="m-0 text-[0.86rem] text-muted italic">
        {{ t('instagramSync.lastRun.never') }}
      </p>
      <div v-else class="grid grid-cols-2 sm:grid-cols-5 gap-[0.75rem]">
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.lastRun.status') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium" :class="lastRunToneClass">
            {{ lastRunStatusLabel }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.lastRun.downloaded') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium tabular-nums">
            {{ formatNumber(lastRun?.downloaded ?? 0) }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.lastRun.skipped') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium tabular-nums">
            {{ formatNumber(lastRun?.skipped ?? 0) }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.lastRun.duration') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium tabular-nums">
            {{ lastRunDuration }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.lastRun.at') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium">{{ lastRunAt }}</span>
        </div>
      </div>
      <p v-if="lastRun && lastRun.error" class="m-0 text-[0.84rem] text-[#b42318]">
        {{ lastRun.error }}
      </p>
    </section>

    <section class="card p-5 md:p-6 flex flex-col gap-4">
      <h2 class="m-0 text-[1.05rem]">{{ t('instagramSync.actions.heading') }}</h2>

      <div class="flex flex-wrap items-center gap-[0.6rem]">
        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="updating || runInProgress"
          @click="handleUpdate"
        >
          <span
            :class="updating ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-download-16-regular'"
            class="w-[0.95rem] h-[0.95rem]"
            aria-hidden="true"
          />
          {{ updating ? t('instagramSync.actions.updating') : t('instagramSync.actions.updateGalleryDl') }}
        </button>

        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="running || runInProgress"
          @click="handleRun"
        >
          <span
            :class="running ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-play-16-filled'"
            class="w-[0.95rem] h-[0.95rem]"
            aria-hidden="true"
          />
          {{ running ? t('instagramSync.actions.running') : t('instagramSync.actions.runNow') }}
        </button>

        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="checking"
          @click="handleCheck"
        >
          <span
            :class="checking ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-sync-16-regular'"
            class="w-[0.95rem] h-[0.95rem]"
            aria-hidden="true"
          />
          {{ checking ? t('instagramSync.actions.checking') : t('instagramSync.actions.checkUpdates') }}
        </button>
      </div>

      <div class="flex flex-col gap-1">
        <label
          class="inline-flex items-center gap-[0.35rem] self-start px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer"
          :class="uploading ? 'opacity-60 pointer-events-none' : ''"
        >
          <span
            :class="uploading ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-cloud-arrow-up-20-filled'"
            class="w-[0.95rem] h-[0.95rem]"
            aria-hidden="true"
          />
          {{ uploading ? t('instagramSync.actions.uploading') : t('instagramSync.actions.uploadCookie') }}
          <input
            class="sr-only"
            type="file"
            accept=".txt,text/plain"
            :disabled="uploading"
            @change="handleCookieFile"
          />
        </label>
        <span class="text-[0.78rem] text-muted">{{ t('instagramSync.actions.cookieHint') }}</span>
      </div>
    </section>

    <section class="card p-5 md:p-6 flex flex-col gap-4">
      <header class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
        <div>
          <h2 class="m-0 text-[1.05rem]">{{ t('instagramSync.collections.heading') }}</h2>
          <p class="m-0 mt-[0.15rem] text-[0.82rem] text-muted">{{ t('instagramSync.collections.subtitle') }}</p>
        </div>
        <div class="flex items-center gap-[0.6rem]">
          <button
            type="button"
            class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="loadingCollections"
            @click="handleLoadCollections"
          >
            <span
              :class="loadingCollections ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-sync-16-regular'"
              class="w-[0.95rem] h-[0.95rem]"
              aria-hidden="true"
            />
            {{ loadingCollections ? t('instagramSync.collections.loading') : t('instagramSync.collections.refresh') }}
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="mirroring || !mirrorableCollections.length"
            @click="handleMirrorAll"
          >
            <span
              :class="mirroring ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-folder-link-16-regular'"
              class="w-[0.95rem] h-[0.95rem]"
              aria-hidden="true"
            />
            {{ mirroring ? t('instagramSync.collections.mirroring') : t('instagramSync.collections.mirrorAll') }}
          </button>
        </div>
      </header>

      <p
        v-if="collectionsError"
        class="m-0 px-3 py-2 rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] text-[0.86rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]"
      >
        {{ collectionsError }}
      </p>

      <p
        v-if="collectionsNotice"
        class="m-0 px-3 py-2 rounded-[0.55rem] border border-[rgba(214,48,49,0.32)] text-[0.84rem] bg-[rgba(214,48,49,0.06)]"
      >
        {{ collectionsNotice }}
      </p>

      <p v-if="!loadingCollections && !collections.length" class="m-0 text-[0.84rem] text-muted">
        {{ t('instagramSync.collections.empty') }}
      </p>

      <ul v-if="collections.length" class="m-0 p-0 list-none grid gap-[0.6rem]">
        <li
          v-for="collection in collections"
          :key="collection.id"
          class="flex items-center justify-between gap-3 px-3 py-[0.6rem] rounded-[0.55rem] border border-border"
        >
          <div class="flex min-w-0 flex-col gap-[0.1rem]">
            <span class="truncate text-[0.9rem] font-semibold">{{ collection.name }}</span>
            <span class="truncate text-[0.76rem] text-muted">
              <template v-if="mirrorResults[collection.name]">
                {{ t('instagramSync.collections.mirrored', {
                  added: formatNumber(mirrorResults[collection.name].addedCount),
                  total: formatNumber(mirrorResults[collection.name].mediaCount)
                }) }}
              </template>
              <template v-else>{{ collection.id }}</template>
            </span>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-[0.35rem] shrink-0 px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="mirroring"
            @click="handleMirrorOne(collection.name)"
          >
            {{ t('instagramSync.collections.mirror') }}
          </button>
        </li>
      </ul>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  checkGalleryDl,
  fetchInstagramCollections,
  fetchInstagramSyncStatus,
  runInstagramSync,
  syncInstagramCollections,
  updateGalleryDl,
  uploadInstagramCookie,
  type InstagramCollection,
  type InstagramCollectionMirrorResult,
  type InstagramGalleryDlCheck,
  type InstagramSyncRun,
  type InstagramSyncStatus,
} from '../api/instagram-sync';
import { RequestError } from '../api/http';

const { t, locale } = useI18n();
const POLL_INTERVAL_MS = 10_000;

const status = ref<InstagramSyncStatus | null>(null);
const check = ref<InstagramGalleryDlCheck | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const updating = ref(false);
const running = ref(false);
const checking = ref(false);
const uploading = ref(false);

const collections = ref<InstagramCollection[]>([]);
const mirrorResults = ref<Record<string, InstagramCollectionMirrorResult>>({});
const loadingCollections = ref(false);
const mirroring = ref(false);
const collectionsError = ref<string | null>(null);
const collectionsNotice = ref<string | null>(null);

/** True while a sync run is in progress, so gallery-dl must not be swapped. */
const runInProgress = ref(false);
/** The `lastRun` record as it was before we asked for a run — a newer record
 *  means that run has finished. */
let lastRunBeforeRun: string | null = null;

let pollTimer: ReturnType<typeof setInterval> | null = null;

function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale.value).format(value);
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isConflict(error: unknown): boolean {
  return error instanceof RequestError && error.status === 409;
}

const galleryDlInstalled = computed(() => {
  const installed = check.value?.installed ?? status.value?.galleryDl.installed ?? null;
  return installed ?? t('instagramSync.status.notInstalled');
});

const galleryDlLatest = computed(() => {
  const latest = check.value?.latest ?? status.value?.galleryDl.latest ?? null;
  return latest ?? t('instagramSync.status.latestUnknown');
});

/** False when the latest published version is unknown (offline / no check yet). */
const galleryDlLatestKnown = computed(() => {
  return (check.value?.latest ?? status.value?.galleryDl.latest ?? null) !== null;
});

const galleryDlUpdateAvailable = computed(() => {
  if (check.value) {
    return check.value.updateAvailable;
  }

  return status.value?.galleryDl.updateAvailable === true;
});

const galleryDlMinRequired = computed(() => {
  const minRequired = status.value?.galleryDl.minRequired;
  return minRequired ?? '—';
});

/** Instagram's catch-all "All posts" is not a real collection to mirror. */
const mirrorableCollections = computed(() => collections.value.filter((c) => !c.isAuto));

const cookieState = computed(() => {
  const cookie = status.value?.cookie;
  if (!cookie?.present) {
    return t('instagramSync.status.cookieMissing');
  }

  return cookie.valid
    ? t('instagramSync.status.cookieValid')
    : t('instagramSync.status.cookieInvalid');
});

const cookieUpdatedAt = computed(() => {
  const updatedAt = status.value?.cookie.updatedAt;
  if (!updatedAt) {
    return t('instagramSync.status.cookieNeverUpdated');
  }

  return t('instagramSync.status.cookieUpdated', { date: formatDateTime(updatedAt) });
});

const archiveEntries = computed(() => {
  const archive = status.value?.archive;
  if (!archive?.present) {
    return t('instagramSync.status.archiveMissing');
  }

  return formatNumber(archive.entries);
});

const archiveSize = computed(() => {
  const archive = status.value?.archive;
  if (!archive?.present) {
    return t('instagramSync.status.archiveEmpty');
  }

  const size = archive.sizeBytes;
  if (size >= 1024 * 1024) {
    return t('instagramSync.status.archiveSizeMb', {
      size: formatNumber(Number((size / (1024 * 1024)).toFixed(1))),
    });
  }

  return t('instagramSync.status.archiveSizeKb', { size: formatNumber(Math.round(size / 1024)) });
});

const scheduleState = computed(() => {
  if (!status.value?.enabled) {
    return t('instagramSync.status.scheduleDisabled');
  }

  return t('instagramSync.status.scheduleEnabled');
});

const cron = computed(() => status.value?.cron ?? '—');

const nextRun = computed(() => {
  const nextRunAt = status.value?.nextRunAt;
  if (!nextRunAt) {
    return t('instagramSync.status.notScheduled');
  }

  return t('instagramSync.status.nextRun', { date: formatDateTime(nextRunAt) });
});

const sourceUrl = computed(() => status.value?.sourceUrl ?? '—');

const lastRun = computed<InstagramSyncRun | null>(() => {
  const run = status.value?.lastRun;
  // A run that never happened has no timestamp.
  return run && run.at ? run : null;
});

const lastRunStatusLabel = computed(() => {
  switch (lastRun.value?.status) {
    case 'ok':
      return t('instagramSync.runStatus.ok');
    case 'failed':
      return t('instagramSync.runStatus.failed');
    case 'skipped':
      return t('instagramSync.runStatus.skipped');
    case 'session-expired':
      return t('instagramSync.runStatus.sessionExpired');
    case 'error':
      return t('instagramSync.runStatus.error');
    default:
      return t('instagramSync.runStatus.unknown');
  }
});

const lastRunToneClass = computed(() => {
  switch (lastRun.value?.status) {
    case 'ok':
      return 'text-[#1f7a3a]';
    case 'failed':
    case 'error':
    case 'session-expired':
      return 'text-[#b42318]';
    default:
      return 'text-text';
  }
});

const lastRunDuration = computed(() => {
  const durationMs = lastRun.value?.durationMs;
  if (durationMs === null || durationMs === undefined) {
    return '—';
  }

  return t('instagramSync.lastRun.durationValue', {
    seconds: formatNumber(Number((durationMs / 1000).toFixed(1))),
  });
});

const lastRunAt = computed(() => formatDateTime(lastRun.value?.at ?? null));

/**
 * The server reports whether a run is in flight. Older builds omit the flag,
 * so fall back to noticing a newer `lastRun` record than the one we had before
 * asking for a run.
 */
function applyRunState(next: InstagramSyncStatus) {
  if (typeof next.running === 'boolean') {
    runInProgress.value = next.running;
    return;
  }

  if (runInProgress.value && next.lastRun) {
    runInProgress.value = JSON.stringify(next.lastRun) === lastRunBeforeRun;
  }
}

async function refresh() {
  loading.value = true;
  try {
    const next = await fetchInstagramSyncStatus();
    status.value = next;
    error.value = null;
    applyRunState(next);
  } catch (e) {
    error.value = messageOf(e, t('instagramSync.loadError'));
  } finally {
    loading.value = false;
  }
}

async function handleUpdate() {
  if (updating.value) {
    return;
  }

  updating.value = true;
  error.value = null;
  notice.value = null;
  try {
    const result = await updateGalleryDl();
    if (result.updated) {
      notice.value = t('instagramSync.actions.updateDone', {
        from: result.from ?? '—',
        to: result.to ?? '—',
      });
    } else {
      notice.value = t('instagramSync.actions.updateUpToDate', { version: result.version ?? '—' });
    }
    await refresh();
    await loadCheck(false);
  } catch (e) {
    error.value = messageOf(e, t('instagramSync.actions.updateFailed'));
  } finally {
    updating.value = false;
  }
}

async function handleCheck() {
  await loadCheck(true);
}

/**
 * `GET /gallery-dl/check` asks PyPI for the newest published gallery-dl. The
 * status endpoint never does this, so the version comparison only becomes
 * meaningful once the check has run.
 */
async function loadCheck(report: boolean) {
  if (checking.value) {
    return;
  }

  checking.value = true;
  if (report) {
    error.value = null;
    notice.value = null;
  }
  try {
    const result = await checkGalleryDl();
    check.value = result;
    if (report) {
      notice.value = result.updateAvailable
        ? t('instagramSync.actions.checkUpdateAvailable', { version: result.latest ?? '—' })
        : t('instagramSync.actions.checkUpToDate', { version: result.installed ?? '—' });
    }
  } catch (e) {
    if (report) {
      error.value = messageOf(e, t('instagramSync.actions.checkFailed'));
    }
  } finally {
    checking.value = false;
  }
}

async function handleRun() {
  if (running.value) {
    return;
  }

  running.value = true;
  error.value = null;
  notice.value = null;
  lastRunBeforeRun = JSON.stringify(status.value?.lastRun ?? null);
  try {
    await runInstagramSync();
    runInProgress.value = true;
    notice.value = t('instagramSync.actions.runStarted');
    await refresh();
  } catch (e) {
    if (isConflict(e)) {
      runInProgress.value = true;
      notice.value = t('instagramSync.actions.alreadyRunning');
    } else {
      error.value = messageOf(e, t('instagramSync.actions.runFailed'));
    }
  } finally {
    running.value = false;
  }
}

async function handleCookieFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  uploading.value = true;
  error.value = null;
  notice.value = null;
  try {
    await uploadInstagramCookie(await file.text());
    notice.value = t('instagramSync.actions.cookieUploaded');
    await refresh();
  } catch (e) {
    error.value = messageOf(e, t('instagramSync.actions.cookieFailed'));
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

async function handleLoadCollections() {
  loadingCollections.value = true;
  collectionsError.value = null;
  try {
    const result = await fetchInstagramCollections();
    collections.value = result.collections ?? [];
  } catch (e) {
    collectionsError.value = messageOf(e, t('instagramSync.collections.loadFailed'));
  } finally {
    loadingCollections.value = false;
  }
}

async function runMirror(name?: string) {
  mirroring.value = true;
  collectionsError.value = null;
  collectionsNotice.value = null;
  try {
    const result = await syncInstagramCollections(name);
    for (const item of result.results ?? []) {
      mirrorResults.value = { ...mirrorResults.value, [item.name]: item };
    }
    const missing = (result.results ?? []).reduce((sum, item) => sum + item.missingCount, 0);
    collectionsNotice.value = missing
      ? t('instagramSync.collections.someMissing', { missing: formatNumber(missing) })
      : t('instagramSync.collections.done');
  } catch (e) {
    collectionsError.value = messageOf(e, t('instagramSync.collections.mirrorFailed'));
  } finally {
    mirroring.value = false;
  }
}

function handleMirrorOne(name: string) {
  void runMirror(name);
}

function handleMirrorAll() {
  void runMirror();
}

onMounted(() => {
  void refresh();
  void loadCheck(false);
  pollTimer = setInterval(() => {
    void refresh();
  }, POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>
