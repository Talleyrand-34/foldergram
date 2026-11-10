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
        <!-- The way back to the settings the plugin hangs off. -->
        <RouterLink
          :to="{ name: 'settings' }"
          class="mb-[0.35rem] inline-flex items-center gap-[0.3rem] text-[0.78rem] font-semibold text-muted no-underline transition-colors duration-150 hover:text-text"
        >
          <span class="i-fluent-arrow-left-16-regular w-[0.9rem] h-[0.9rem]" aria-hidden="true" />
          {{ t('settings.backToSettings') }}
        </RouterLink>
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
          <span class="block text-[0.74rem] text-muted">{{ pollIntervalLabel }}</span>
          <span class="block text-[0.74rem] text-muted break-all">{{ sourceUrl }}</span>
        </div>
      </div>
    </section>

    <section class="card p-5 md:p-6 flex flex-col gap-4">
      <header class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
        <div>
          <h2 class="m-0 text-[1.05rem]">{{ t('instagramSync.poll.heading') }}</h2>
          <p class="m-0 mt-[0.15rem] text-[0.82rem] text-muted">
            {{ t('instagramSync.poll.subtitle') }}
          </p>
        </div>
        <label
          class="inline-flex items-center gap-[0.4rem] self-start px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text cursor-pointer select-none"
        >
          <input v-model="pollForm.enabled" type="checkbox" class="accent-current" />
          {{ t('instagramSync.poll.enabled') }}
        </label>
      </header>

      <div class="flex flex-col gap-1">
        <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('instagramSync.poll.interval') }}
        </span>
        <div class="flex flex-wrap items-center gap-[0.6rem]">
          <select
            v-model="intervalPreset"
            class="px-3 py-[0.5rem] text-[0.82rem] rounded-[0.55rem] border border-border bg-surface text-text"
          >
            <option
              v-for="preset in intervalPresets"
              :key="preset.minutes"
              :value="String(preset.minutes)"
            >
              {{ preset.label }}
            </option>
            <option value="custom">{{ t('instagramSync.poll.intervalCustom') }}</option>
          </select>
          <label
            v-if="intervalPreset === 'custom'"
            class="inline-flex items-center gap-[0.35rem] text-[0.82rem] text-muted"
          >
            <input
              v-model.number="pollForm.intervalMinutes"
              type="number"
              :min="pollLimits.min"
              :max="pollLimits.max"
              class="w-[6.5rem] px-2 py-[0.4rem] text-[0.82rem] rounded-[0.55rem] border border-border bg-surface text-text tabular-nums"
            />
            {{ t('instagramSync.poll.intervalUnit') }}
          </label>
        </div>
        <span class="text-[0.78rem] text-muted">{{ t('instagramSync.poll.intervalHint') }}</span>
      </div>

      <fieldset class="m-0 p-0 border-0 flex flex-col gap-2">
        <legend class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase mb-1">
          {{ t('instagramSync.poll.scope') }}
        </legend>

        <label class="inline-flex items-center gap-[0.4rem] text-[0.85rem] cursor-pointer">
          <input v-model="pollForm.library" type="checkbox" class="accent-current" />
          <span>{{ t('instagramSync.poll.scopeLibrary') }}</span>
        </label>

        <label class="inline-flex items-center gap-[0.4rem] text-[0.85rem] cursor-pointer">
          <input v-model="pollForm.collections" type="checkbox" class="accent-current" />
          <span>{{ t('instagramSync.poll.scopeCollections') }}</span>
        </label>

        <div v-if="pollForm.collections" class="flex flex-col gap-2 pl-[1.2rem]">
          <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
            <input
              v-model="pollForm.collectionMode"
              type="radio"
              value="all"
              class="accent-current"
            />
            <span>{{ t('instagramSync.poll.scopeAllCollections') }}</span>
          </label>
          <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
            <input
              v-model="pollForm.collectionMode"
              type="radio"
              value="selected"
              class="accent-current"
            />
            <span>{{ t('instagramSync.poll.scopeSelectedCollections') }}</span>
          </label>

          <ul
            v-if="pollForm.collectionMode === 'selected'"
            class="m-0 p-0 list-none flex flex-col gap-1"
          >
            <li v-for="collection in mirrorableCollections" :key="collection.id">
              <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
                <input
                  v-model="pollForm.collectionIds"
                  type="checkbox"
                  :value="collection.id"
                  class="accent-current"
                />
                <span class="truncate">{{ collection.name }}</span>
              </label>
            </li>
          </ul>
          <p
            v-if="pollForm.collectionMode === 'selected' && !mirrorableCollections.length"
            class="m-0 text-[0.8rem] text-muted"
          >
            {{ t('instagramSync.poll.collectionsEmpty') }}
          </p>
        </div>
      </fieldset>

      <div class="flex flex-wrap items-center gap-[0.6rem]">
        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="savingPoll"
          @click="handleSavePoll"
        >
          <span
            :class="savingPoll ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-save-16-regular'"
            class="w-[0.95rem] h-[0.95rem]"
            aria-hidden="true"
          />
          {{ savingPoll ? t('instagramSync.poll.saving') : t('instagramSync.poll.save') }}
        </button>

        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="pollRunning"
          @click="handleRunPoll"
        >
          <span
            :class="pollRunning ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-play-16-filled'"
            class="w-[0.95rem] h-[0.95rem]"
            aria-hidden="true"
          />
          {{ pollRunning ? t('instagramSync.poll.running') : t('instagramSync.poll.runNow') }}
        </button>
      </div>

      <p
        v-if="pollError"
        role="alert"
        class="m-0 px-3 py-2 rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] text-[0.84rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]"
      >
        {{ pollError }}
      </p>

      <p
        v-if="pollNotice"
        role="status"
        class="m-0 px-3 py-2 rounded-[0.55rem] border border-[rgba(31,122,58,0.28)] text-[0.84rem] bg-[rgba(31,122,58,0.06)]"
      >
        {{ pollNotice }}
      </p>

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-[0.75rem]">
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.poll.interval') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium">
            {{ pollForm.enabled ? formatInterval(pollForm.intervalMinutes) : '—' }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.poll.nextRunLabel') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium">{{ pollNextRun }}</span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.poll.lastPollLabel') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium" :class="pollResultToneClass">
            {{ pollResultLabel }}
          </span>
          <span class="block text-[0.74rem] text-muted">{{ pollLastRun }}</span>
        </div>
      </div>

      <!-- A poll in flight: what it is doing right now. -->
      <div
        v-if="pollInFlight"
        class="px-3 py-2.5 rounded-[0.55rem] border border-border bg-surface-alt flex flex-col gap-[0.35rem]"
      >
        <div class="flex items-center gap-[0.45rem] text-[0.84rem]">
          <span class="i-fluent-arrow-sync-16-filled animate-spin w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
          <span class="font-semibold">{{ t('instagramSync.poll.runningNow') }}</span>
          <span class="text-muted">{{ pollLastRun }}</span>
        </div>
        <p v-if="pollProgress" class="m-0 text-[0.8rem] text-muted">{{ pollProgress }}</p>
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
      <p
        v-if="lastRun?.stoppedEarly"
        class="m-0 text-[0.84rem] text-muted"
      >
        {{ t('instagramSync.lastRun.stoppedEarly') }}
      </p>
    </section>

    <!-- The early-exit budgets, and an intensive scan waiting to run. -->
    <section
      v-if="status?.budgets"
      class="card p-5 md:p-6 flex flex-col gap-3"
    >
      <h2 class="m-0 text-[1.05rem]">{{ t('instagramSync.budgets.heading') }}</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-[0.75rem]">
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.budgets.feed') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium tabular-nums">
            {{ status.budgets.feed }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.budgets.collections') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium tabular-nums">
            {{ status.budgets.collections }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('instagramSync.budgets.intensive') }}
          </span>
          <span class="block mt-[0.15rem] text-[0.95rem] font-medium tabular-nums">
            {{ status.budgets.intensive }}
          </span>
        </div>
      </div>
      <p class="m-0 text-[0.84rem] text-muted">
        {{ t('instagramSync.budgets.hint') }}
      </p>
      <p
        v-if="status.deepScan && (status.deepScan.library || status.deepScan.collections)"
        class="m-0 text-[0.84rem] text-[#b42318]"
      >
        {{ t('instagramSync.budgets.intensivePending', { reason: status.deepScan.reason ?? '' }) }}
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
            <span v-if="mirrorableCollections.length" class="text-muted font-normal">
              ({{ formatNumber(mirrorableCollections.length) }})
            </span>
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
        class="m-0 px-3 py-2 rounded-[0.55rem] border border-[rgba(31,122,58,0.28)] text-[0.84rem] bg-[rgba(31,122,58,0.06)]"
      >
        {{ collectionsNotice }}
      </p>

      <p v-if="!loadingCollections && !collections.length" class="m-0 text-[0.84rem] text-muted">
        {{ t('instagramSync.collections.empty') }}
      </p>

      <!-- Live progress while a mirror runs -->
      <div
        v-if="mirrorJob && mirrorJob.running"
        class="px-3 py-2.5 rounded-[0.55rem] border border-border bg-surface-alt flex flex-col gap-[0.35rem]"
      >
        <div class="flex items-center gap-[0.45rem] text-[0.84rem]">
          <span class="i-fluent-arrow-sync-16-filled animate-spin w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
          <span class="font-semibold">{{ mirrorProgressLabel }}</span>
        </div>
        <div
          v-if="mirrorJob.currentCollection && mirrorJob.mediaFound !== null"
          class="text-[0.8rem] text-muted"
        >
          {{ t('instagramSync.collections.foundMedia', { count: formatNumber(mirrorJob.mediaFound) }) }}
        </div>
        <ul v-if="mirrorJob.log.length" class="m-0 p-0 list-none flex flex-col gap-[0.1rem]">
          <li
            v-for="(line, index) in mirrorJob.log.slice(-6)"
            :key="index"
            class="text-[0.76rem] text-muted font-mono truncate"
          >
            {{ line }}
          </li>
        </ul>
      </div>

      <ul v-if="collections.length" class="m-0 p-0 list-none grid gap-[0.6rem]">
        <li
          v-for="collection in collections"
          :key="collection.id"
          class="flex items-center justify-between gap-3 px-3 py-[0.6rem] rounded-[0.55rem] border border-border"
        >
          <div class="flex min-w-0 flex-col gap-[0.15rem]">
            <span class="flex items-center gap-[0.35rem] min-w-0">
              <span class="truncate text-[0.9rem] font-semibold">{{ collection.name }}</span>
              <span
                v-if="collectionStatusLabel(collection)"
                class="shrink-0 text-[0.68rem] font-semibold leading-none px-[0.35rem] py-[0.2rem] rounded-[0.3rem]"
                :class="collectionStatusClass(collection)"
              >
                {{ collectionStatusLabel(collection) }}
              </span>
            </span>
            <span class="truncate text-[0.76rem] text-muted">
              <template v-if="collection.state">
                {{ t('instagramSync.collections.postCounts', {
                  posts: formatNumber(collection.state.mediaCount),
                  synced: formatNumber(collection.state.syncedCount)
                }) }}
                <template v-if="collection.state.lastSyncedAt">
                  · {{ t('instagramSync.collections.lastSynced', { date: formatDateTime(collection.state.lastSyncedAt) }) }}
                </template>
              </template>
              <template v-else-if="mirrorResults[collection.name]">
                {{ t('instagramSync.collections.mirrored', {
                  added: formatNumber(mirrorResults[collection.name].addedCount),
                  total: formatNumber(mirrorResults[collection.name].mediaCount)
                }) }}
              </template>
              <template v-else>{{ t('instagramSync.collections.notMirrored') }}</template>
            </span>
            <span
              v-if="collection.state && collection.state.lastError"
              class="truncate text-[0.74rem] text-[#b42318]"
            >
              {{ collection.state.lastError }}
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
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import {
  checkGalleryDl,
  fetchInstagramCollections,
  fetchInstagramMirrorJob,
  fetchInstagramPoll,
  fetchInstagramSyncStatus,
  runInstagramPoll,
  runInstagramSync,
  saveInstagramPoll,
  syncInstagramCollections,
  updateGalleryDl,
  uploadInstagramCookie,
  type InstagramCollection,
  type InstagramCollectionMirrorResult,
  type InstagramMirrorJob,
  type InstagramGalleryDlCheck,
  type InstagramPollCollectionMode,
  type InstagramPollConfig,
  type InstagramPollState,
  type InstagramSyncRun,
  type InstagramSyncStatus,
} from '../api/instagram-sync';
import { RequestError } from '../api/http';

const { t, locale } = useI18n();
const POLL_INTERVAL_MS = 10_000;
/** The mirror job is polled more often — it is the thing the user is waiting on. */
const MIRROR_POLL_INTERVAL_MS = 2_000;

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
const mirrorJob = ref<InstagramMirrorJob | null>(null);
const loadingCollections = ref(false);
const mirroring = ref(false);
const collectionsError = ref<string | null>(null);
const collectionsNotice = ref<string | null>(null);

/** The polling configuration, as the server has it. */
const poll = ref<InstagramPollState | null>(null);
/** The configuration being edited — it is only sent when the user saves. */
const pollForm = reactive({
  enabled: true,
  intervalMinutes: 240,
  library: true,
  collections: true,
  collectionMode: 'all' as InstagramPollCollectionMode,
  collectionIds: [] as string[],
});
const pollError = ref<string | null>(null);
const pollNotice = ref<string | null>(null);
const savingPoll = ref(false);
const pollRunning = ref(false);
/** The interval presets offered in the dropdown, in minutes. */
const INTERVAL_PRESETS = [15, 30, 60, 120, 240, 360, 720, 1440, 10080];
/** Which preset the dropdown shows: a number of minutes, or "custom". */
const intervalPreset = ref('240');
/** The names of the saved collections, by Instagram id. */
const savedCollectionNames = ref<Record<string, string>>({});

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

function collectionStatusLabel(collection: InstagramCollection): string {
  switch (collection.state?.status) {
    case 'ok':
      return t('instagramSync.collections.statusOk');
    case 'partial':
      return t('instagramSync.collections.statusPartial');
    case 'failed':
      return t('instagramSync.collections.statusFailed');
    default:
      return '';
  }
}

function collectionStatusClass(collection: InstagramCollection): string {
  switch (collection.state?.status) {
    case 'ok':
      return 'text-[#1f7a3a] bg-[rgba(31,122,58,0.10)]';
    case 'partial':
      return 'text-[#9f6a00] bg-[rgba(159,106,0,0.10)]';
    case 'failed':
      return 'text-[#b42318] bg-[rgba(217,48,37,0.10)]';
    default:
      return '';
  }
}

/** Instagram's catch-all "All posts" is not a real collection to mirror. */
const mirrorableCollections = computed(() => collections.value.filter((c) => !c.isAuto));

const mirrorProgressLabel = computed(() => {
  const job = mirrorJob.value;
  if (!job?.running) return t('instagramSync.collections.mirroring');

  const current = job.currentCollection;
  const counter =
    job.totalCount !== null ? ` (${job.completedCount}/${job.totalCount})` : '';

  return current
    ? t('instagramSync.collections.progressCollection', { name: current }) + counter
    : t('instagramSync.collections.progress') + counter;
});

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

/** The interval, in a form a human reads: "4 h", "30 min", "7 d". */
function formatInterval(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return t('instagramSync.poll.unit.day', { count: minutes / 1440 });
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return t('instagramSync.poll.unit.hour', { count: minutes / 60 });
  }
  return t('instagramSync.poll.unit.minute', { count: minutes });
}

const intervalPresets = computed(() =>
  INTERVAL_PRESETS.map((minutes) => ({ minutes, label: formatInterval(minutes) })),
);

const pollLimits = computed(() => ({
  min: poll.value?.limits.minIntervalMinutes ?? 15,
  max: poll.value?.limits.maxIntervalMinutes ?? 10080,
}));

/** The interval as the status card shows it. */
const pollIntervalLabel = computed(() => {
  const summary = status.value?.poll;
  if (!summary) return '—';
  if (!summary.enabled) return t('instagramSync.status.scheduleDisabled');

  return t('instagramSync.status.pollInterval', {
    interval: formatInterval(summary.intervalMinutes),
  });
});

const pollNextRun = computed(() => {
  const nextRunAt = poll.value?.nextRunAt;
  if (!nextRunAt) {
    return t('instagramSync.poll.noNextRun');
  }

  return t('instagramSync.poll.nextRun', { date: formatDateTime(nextRunAt) });
});

const pollLastRun = computed(() => {
  const lastRun = poll.value?.lastRun;
  if (!lastRun?.at) {
    return t('instagramSync.poll.lastPollNever');
  }

  return t('instagramSync.poll.lastPoll', { date: formatDateTime(lastRun.at) });
});

/** How the last poll ended. */
const pollResultLabel = computed(() => {
  switch (poll.value?.lastRun?.status) {
    case 'ok':
      return t('instagramSync.poll.resultOk');
    case 'failed':
      return t('instagramSync.poll.resultFailed');
    case 'skipped':
      return t('instagramSync.poll.resultSkipped');
    case 'running':
      return t('instagramSync.poll.resultRunning');
    case 'error':
      return t('instagramSync.poll.resultError');
    default:
      return t('instagramSync.poll.resultUnknown');
  }
});

/** What the poll in flight is doing right now. */
const pollProgress = computed(() => {
  const lastRun = poll.value?.lastRun;
  if (!lastRun || lastRun.status !== 'running') return '';

  if (lastRun.currentCollection && lastRun.mirroredTotal !== null) {
    return t('instagramSync.poll.progressCollection', {
      name: lastRun.currentCollection,
      done: lastRun.mirrored,
      total: lastRun.mirroredTotal
    });
  }
  if (lastRun.library) {
    return t('instagramSync.poll.progressCollections');
  }
  return t('instagramSync.poll.progressLibrary');
});

/** True while a poll is in flight — the server's state wins over the button. */
const pollInFlight = computed(
  () => pollRunning.value || poll.value?.lastRun?.status === 'running'
);

const pollResultToneClass = computed(() => {
  switch (poll.value?.lastRun?.status) {
    case 'ok':
      return 'text-[#1f7a3a]';
    case 'running':
      return 'text-accent-strong';
    case 'failed':
    case 'error':
      return 'text-[#b42318]';
    default:
      return 'text-text';
  }
});

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
    case 'archive-unavailable':
      return t('instagramSync.runStatus.archiveUnavailable');
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
    case 'archive-unavailable':
      // The sync worked; only the download archive was unavailable.
      return 'text-[#9f6a00]';
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
  void refreshMirrorJob();
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

/**
 * Load the polling configuration and put it into the form.
 *
 * The form is only ever overwritten by the server's answer, so a failed save
 * does not silently reset what the user typed.
 */
async function loadPoll() {
  try {
    const state = await fetchInstagramPoll();
    poll.value = state;
    pollRunning.value = state.running;
    applyPollConfig(state.config);
  } catch (e) {
    pollError.value = messageOf(e, t('instagramSync.poll.loadFailed'));
  }
}

/**
 * Refresh the polling state without touching the form.
 *
 * The periodic refresh must not overwrite what the user is editing, so the
 * form is only filled in on mount and after a save.
 */
async function refreshPollState() {
  try {
    const state = await fetchInstagramPoll();
    poll.value = state;
    pollRunning.value = state.running;
  } catch {
    // The server may be unreachable; the form still works.
  }
}

function applyPollConfig(config: InstagramPollConfig) {
  pollForm.enabled = config.enabled;
  pollForm.intervalMinutes = config.intervalMinutes;
  pollForm.library = config.library;
  pollForm.collections = config.collections;
  pollForm.collectionMode = config.collectionMode;
  pollForm.collectionIds = [...config.collectionIds];

  // The names travel alongside the ids so a selection survives a collection
  // that is not loaded (yet).
  const names: Record<string, string> = {};
  config.collectionIds.forEach((id, index) => {
    names[id] = config.collectionNames[index] ?? id;
  });
  savedCollectionNames.value = names;

  intervalPreset.value = INTERVAL_PRESETS.includes(config.intervalMinutes)
    ? String(config.intervalMinutes)
    : 'custom';
}

/** The name of a collection, from the loaded list or from the saved one. */
function collectionNameOf(id: string): string {
  const loaded = collections.value.find((collection) => collection.id === id);
  if (loaded) return loaded.name;

  return savedCollectionNames.value[id] ?? id;
}

async function handleSavePoll() {
  savingPoll.value = true;
  pollError.value = null;
  pollNotice.value = null;
  try {
    await saveInstagramPoll({
      enabled: pollForm.enabled,
      intervalMinutes: pollForm.intervalMinutes,
      library: pollForm.library,
      collections: pollForm.collections,
      collectionMode: pollForm.collectionMode,
      collectionIds: pollForm.collectionIds,
      collectionNames: pollForm.collectionIds.map((id) => collectionNameOf(id)),
    });
    pollNotice.value = t('instagramSync.poll.saved');
    await loadPoll();
  } catch (e) {
    pollError.value = messageOf(e, t('instagramSync.poll.saveFailed'));
  } finally {
    savingPoll.value = false;
  }
}

async function handleRunPoll() {
  pollError.value = null;
  pollNotice.value = null;
  try {
    await runInstagramPoll();
    pollRunning.value = true;
    pollNotice.value = t('instagramSync.poll.started');
  } catch (e) {
    if (isConflict(e)) {
      pollRunning.value = true;
      pollNotice.value = t('instagramSync.poll.alreadyRunning');
      return;
    }

    pollError.value = messageOf(e, t('instagramSync.poll.runFailed'));
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

async function refreshMirrorJob() {
  try {
    const job = await fetchInstagramMirrorJob();
    mirrorJob.value = job;
    if (job.running && !mirroring.value) {
      mirroring.value = true;
      void pollMirrorJob();
    }
  } catch {
    // The server may be unreachable; the buttons still work.
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

/**
 * Mirroring runs on the server in the background — one collection takes
 * minutes — so the request returns immediately and the result is polled.
 */
async function runMirror(name?: string) {
  collectionsError.value = null;
  collectionsNotice.value = null;
  try {
    await syncInstagramCollections(name);
    mirroring.value = true;
    await pollMirrorJob();
  } catch (e) {
    if (isConflict(e)) {
      // A mirror is already running on the server — join it rather than
      // treating it as a failure.
      mirroring.value = true;
      void pollMirrorJob();
      return;
    }

    mirroring.value = false;
    collectionsError.value = messageOf(e, t('instagramSync.collections.mirrorFailed'));
  }
}

async function pollMirrorJob() {
  while (mirroring.value) {
    await new Promise((resolve) => setTimeout(resolve, MIRROR_POLL_INTERVAL_MS));
    if (!mirroring.value) return;

    let job;
    try {
      job = await fetchInstagramMirrorJob();
    } catch {
      // A transient poll failure is not a mirror failure; keep trying.
      continue;
    }

    mirrorJob.value = job;
    for (const item of job.results ?? []) {
      mirrorResults.value = { ...mirrorResults.value, [item.name]: item };
    }

    if (job.running) continue;

    mirroring.value = false;
    if (job.error) {
      collectionsError.value = job.error;
      return;
    }

    const missing = (job.results ?? []).reduce((sum, item) => sum + item.missingCount, 0);
    collectionsNotice.value = missing
      ? t('instagramSync.collections.someMissing', { missing: formatNumber(missing) })
      : t('instagramSync.collections.done');
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
  void loadPoll();
  void loadCheck(false);
  void adoptRunningMirror();
  // The polling form can narrow the poll to a selection of collections, so
  // the list is needed to pick from.
  void handleLoadCollections();
  pollTimer = setInterval(() => {
    void refresh();
    void refreshPollState();
  }, POLL_INTERVAL_MS);
});

/**
 * A mirror may already be running — the user can navigate away and back, or
 * press the button twice. Pick up its state instead of showing idle buttons
 * that would only fail with a conflict.
 */
async function adoptRunningMirror() {
  try {
    const job = await fetchInstagramMirrorJob();
    mirrorJob.value = job;
    if (!job.running) return;

    mirroring.value = true;
    for (const item of job.results ?? []) {
      mirrorResults.value = { ...mirrorResults.value, [item.name]: item };
    }
    await pollMirrorJob();
  } catch {
    // The server may be unreachable; the buttons still work.
  }
}

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  mirroring.value = false;
});
</script>
