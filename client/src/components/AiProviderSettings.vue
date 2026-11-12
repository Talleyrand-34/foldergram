<!--
  AiProviderSettings — the AI analysis configuration.

  Two things the admin controls here:

    1. **Providers** — an endpoint, its credentials and its default model.
       The API key is never sent back by the server, so the field shows
       "a key is stored" instead of the key itself.

    2. **The pipeline** — what each stage does. Which provider and model the
       vision, audio and embedding stages use, whether the canonicalizer runs,
       how many frames are sampled and where, whether the audio is
       transcribed, whether the caption is written back, and whether the
       knowledge graph is updated.

  The configuration is global: one library, one set of providers.
-->

<template>
  <section class="card p-5 md:p-6 flex flex-col gap-5">
    <header class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
      <div>
        <span class="eyebrow">{{ t('ai.config.eyebrow') }}</span>
        <h2 class="m-0 text-[1.1rem]">{{ t('ai.config.title') }}</h2>
        <p class="m-0 mt-[0.15rem] text-muted text-[0.86rem]">{{ t('ai.config.subtitle') }}</p>
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

    <div v-if="error" role="alert" class="px-3 py-2 rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] text-[0.86rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]">
      {{ error }}
    </div>

    <div v-if="notice" role="status" class="px-3 py-2 rounded-[0.55rem] border border-[rgba(31,122,58,0.28)] text-[0.86rem] bg-[rgba(31,122,58,0.06)]">
      {{ notice }}
    </div>

    <ul v-if="configErrors.length" class="m-0 p-0 list-none flex flex-col gap-1">
      <li
        v-for="(problem, index) in configErrors"
        :key="index"
        class="px-3 py-1.5 rounded-[0.55rem] border border-[rgba(214,48,49,0.28)] text-[0.82rem] text-[#b42318] bg-[rgba(214,48,49,0.05)]"
      >
        {{ problem }}
      </li>
    </ul>

    <!-- ---------- providers ---------- -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <h3 class="m-0 text-[0.95rem]">{{ t('ai.config.providers') }}</h3>
        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] px-3 py-[0.4rem] text-[0.76rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="loading"
          @click="addProvider"
        >
          <span class="i-fluent-add-16-regular w-[0.9rem] h-[0.9rem]" aria-hidden="true" />
          {{ t('ai.config.addProvider') }}
        </button>
      </div>

      <p v-if="!providers.length" class="m-0 text-[0.86rem] text-muted italic">
        {{ t('ai.config.noProviders') }}
      </p>

      <!-- A ready-made MiniMax provider: the server reaches api.minimax.io
           directly, so it needs no gateway. -->
      <button
        type="button"
        class="inline-flex items-center gap-[0.35rem] self-start px-3 py-[0.45rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-alt text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
        @click="addMiniMaxProvider"
      >
        <span class="i-fluent-add-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
        {{ t('ai.config.addMiniMax') }}
      </button>

      <div
        v-for="(provider, index) in providers"
        :key="provider.id || index"
        class="grid gap-3 px-3 py-3 rounded-[0.55rem] border border-border bg-surface-alt"
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1">
            <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.providerLabel') }}
            </span>
            <input
              v-model="provider.label"
              type="text"
              class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text focus:outline-none focus:border-text"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.dialect') }}
            </span>
            <select
              v-model="provider.dialect"
              class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
            >
              <option value="openai-compatible">{{ t('ai.config.dialectOpenAi') }}</option>
              <option value="minimax">{{ t('ai.config.dialectMiniMax') }}</option>
            </select>
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.baseUrl') }}
            </span>
            <input
              v-model="provider.baseUrl"
              type="text"
              placeholder="http://10.0.2.31:4000/v1"
              class="px-2.5 py-[0.4rem] text-[0.85rem] font-mono bg-surface border border-border rounded text-text focus:outline-none focus:border-text"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.defaultModel') }}
            </span>
            <AiModelSelect
              v-model="provider.defaultModel"
              :provider-id="provider.id"
              :placeholder="t('ai.config.modelPlaceholder')"
            />
          </label>

          <label class="flex flex-col gap-1">
            <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.apiKey') }}
            </span>
            <input
              v-model="provider.apiKey"
              type="password"
              :placeholder="provider.hasApiKey ? provider.apiKeyMasked : t('ai.config.noKey')"
              autocomplete="off"
              class="px-2.5 py-[0.4rem] text-[0.85rem] font-mono bg-surface border border-border rounded text-text focus:outline-none focus:border-text"
            />
            <span v-if="provider.hasApiKey" class="text-[0.72rem] text-muted">
              {{ t('ai.config.keyStored') }}
            </span>
          </label>

          <!-- MiniMax's thinking controls. -->
          <template v-if="provider.dialect === 'minimax'">
            <label class="flex flex-col gap-1">
              <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
                {{ t('ai.config.thinking') }}
              </span>
              <select
                v-model="provider.thinkingType"
                class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
              >
                <option value="">{{ t('ai.config.apiDefault') }}</option>
                <option value="adaptive">adaptive</option>
                <option value="disabled">disabled</option>
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-[0.72rem] font-bold tracking-[0.06em] text-muted uppercase">
                {{ t('ai.config.reasoningEffort') }}
              </span>
              <select
                v-model="provider.reasoningEffort"
                class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
              >
                <option value="">{{ t('ai.config.apiDefault') }}</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max</option>
              </select>
            </label>
          </template>
        </div>

        <!-- ---------- this provider's usage limits ---------- -->
        <div class="grid gap-2 px-3 py-2.5 rounded-[0.55rem] border border-border bg-surface">
          <div class="flex items-center justify-between gap-3">
            <span class="text-[0.8rem] font-semibold">{{ t('ai.config.usageLimits') }}</span>
            <label class="inline-flex items-center gap-[0.4rem] text-[0.8rem] cursor-pointer">
              <input v-model="provider.usageLimits.enabled" type="checkbox" class="accent-current" />
              <span>{{ t('ai.config.enabled') }}</span>
            </label>
          </div>

          <!-- Hard limits or the shared plan? -->
          <label class="flex flex-col gap-1 max-w-[16rem]">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.usageMode') }}
            </span>
            <select
              v-model="provider.usageLimits.mode"
              class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
            >
              <option value="hard">{{ t('ai.config.modeHard') }}</option>
              <option value="smart">{{ t('ai.config.modeSmart') }}</option>
            </select>
            <span class="text-[0.75rem] text-muted">{{ t('ai.config.modeHint') }}</span>
          </label>

          <label class="flex flex-col gap-1 max-w-[14rem]">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.budget') }}
            </span>
            <div class="flex items-center gap-[0.4rem]">
              <input
                v-model.number="provider.usageLimits.budget"
                type="number"
                min="0"
                step="100000"
                class="w-[9rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
              />
              <span class="text-[0.8rem] text-muted">{{ t('ai.config.tokens') }}</span>
            </div>
          </label>

          <div v-if="provider.usageLimits.mode === 'hard'" class="grid gap-2">
            <div
              v-for="(window, windowIndex) in provider.usageLimits.windows"
              :key="windowIndex"
              class="flex flex-wrap items-end gap-[0.5rem]"
            >
              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.windowLength') }}
                </span>
                <div class="flex items-center gap-[0.35rem]">
                  <input
                    v-model.number="window.hours"
                    type="number"
                    min="1"
                    class="w-[5.5rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
                  />
                  <span class="text-[0.8rem] text-muted">{{ t('ai.config.hours') }}</span>
                </div>
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.share') }}
                </span>
                <div class="flex items-center gap-[0.35rem]">
                  <input
                    v-model.number="window.percent"
                    type="number"
                    min="1"
                    max="100"
                    class="w-[5.5rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
                  />
                  <span class="text-[0.8rem] text-muted">%</span>
                </div>
              </label>
              <button
                type="button"
                class="inline-flex items-center justify-center w-7 h-7 rounded-full border-0 bg-transparent text-[#b42318] cursor-pointer hover:bg-[rgba(217,48,37,0.08)]"
                :aria-label="t('ai.config.removeWindow')"
                :title="t('ai.config.removeWindow')"
                @click="removeUsageWindow(provider, windowIndex)"
              >
                <span class="i-fluent-delete-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div v-if="provider.usageLimits.mode === 'hard'" class="flex items-center gap-[0.5rem]">
            <button
              type="button"
              class="inline-flex items-center gap-[0.35rem] self-start px-2.5 py-[0.35rem] text-[0.74rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer"
              @click="addUsageWindow(provider)"
            >
              <span class="i-fluent-add-16-regular w-[0.85rem] h-[0.85rem]" aria-hidden="true" />
              {{ t('ai.config.addWindow') }}
            </button>
            <span class="text-[0.75rem] text-muted">{{ t('ai.config.windowHint') }}</span>
          </div>

          <!-- ---------- the shared plan ---------- -->
          <div
            v-if="provider.usageLimits.mode === 'smart'"
            class="grid gap-2 px-2.5 py-2 rounded-[0.45rem] border border-border bg-surface-alt"
          >
            <label class="flex flex-col gap-1">
              <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                {{ t('ai.config.probeUrl') }}
              </span>
              <input
                v-model.trim="provider.usageLimits.smart.probeUrl"
                type="text"
                placeholder="https://api.minimax.io/v1/token_plan/remains"
                class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
              />
              <span class="text-[0.75rem] text-muted">{{ t('ai.config.probeUrlHint') }}</span>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                {{ t('ai.config.probeKey') }}
              </span>
              <input
                v-model.trim="provider.usageLimits.smart.probeApiKey"
                type="password"
                :placeholder="provider.usageLimits.smart.hasProbeApiKey
                  ? provider.usageLimits.smart.probeApiKeyMasked
                  : t('ai.config.probeKeyEmpty')"
                class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
              />
            </label>

            <div class="grid gap-2 sm:grid-cols-3">
              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.watch') }}
                </span>
                <select
                  v-model="provider.usageLimits.smart.watch"
                  class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text"
                >
                  <option value="interval">{{ t('ai.config.watchInterval') }}</option>
                  <option value="weekly">{{ t('ai.config.watchWeekly') }}</option>
                  <option value="both">{{ t('ai.config.watchBoth') }}</option>
                </select>
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.pollMinutes') }}
                </span>
                <input
                  v-model.number="provider.usageLimits.smart.pollMinutes"
                  type="number"
                  min="1"
                  max="60"
                  class="w-[5.5rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
                />
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.contentionPercent') }}
                </span>
                <input
                  v-model.number="provider.usageLimits.smart.contentionPercent"
                  type="number"
                  min="0"
                  max="100"
                  class="w-[5.5rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
                />
              </label>
            </div>

            <div class="grid gap-2 sm:grid-cols-2">
              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.idlePercent') }}
                </span>
                <input
                  v-model.number="provider.usageLimits.smart.idlePercent"
                  type="number"
                  min="0"
                  max="100"
                  class="w-[5.5rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
                />
                <span class="text-[0.75rem] text-muted">{{ t('ai.config.idlePercentHint') }}</span>
              </label>

              <label class="flex flex-col gap-1">
                <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
                  {{ t('ai.config.yieldPercent') }}
                </span>
                <input
                  v-model.number="provider.usageLimits.smart.yieldPercent"
                  type="number"
                  min="0"
                  max="100"
                  class="w-[5.5rem] px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
                />
                <span class="text-[0.75rem] text-muted">{{ t('ai.config.yieldPercentHint') }}</span>
              </label>
            </div>

            <label class="inline-flex items-center gap-[0.4rem] text-[0.8rem] cursor-pointer">
              <input
                v-model="provider.usageLimits.smart.ignoreHardWindows"
                type="checkbox"
                class="accent-current"
              />
              <span>{{ t('ai.config.ignoreHardWindows') }}</span>
            </label>
            <span class="text-[0.75rem] text-muted">{{ t('ai.config.planIsTheLimitHint') }}</span>

            <!-- What the plan says right now. -->
            <div
              v-if="smartState(provider.id)"
              class="flex flex-col gap-1 px-2.5 py-2 rounded-[0.45rem] border border-border bg-surface"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="text-[0.78rem] font-semibold">{{ t('ai.config.planNow') }}</span>
                <span
                  v-if="smartState(provider.id)?.contended"
                  class="text-[0.7rem] font-semibold px-[0.3rem] py-[0.12rem] rounded-[0.3rem] text-[#b42318] bg-[rgba(217,48,37,0.10)]"
                >
                  {{ t('ai.config.planShared') }}
                </span>
              </div>
              <span
                v-if="!smartState(provider.id)?.probeOk"
                class="text-[0.76rem] text-[#b42318]"
              >
                {{ smartState(provider.id)?.probeError }}
              </span>

              <!-- Every window the plan publishes, and what is left of it. -->
              <ul
                v-else-if="smartState(provider.id)?.windows?.length"
                class="m-0 p-0 list-none grid gap-[0.2rem]"
              >
                <li
                  v-for="window in smartState(provider.id)?.windows"
                  :key="window.kind"
                  class="text-[0.78rem] tabular-nums text-muted flex flex-wrap items-baseline gap-x-2"
                >
                  <span class="font-semibold text-text">
                    {{ window.kind === 'interval' ? t('ai.config.planWindowInterval') : t('ai.config.planWindowWeekly') }}
                  </span>
                  <span>{{ window.remainingPercent }}% {{ t('ai.config.planLeft') }}</span>
                  <span v-if="window.hoursLeft !== null">
                    · {{ t('ai.config.planLasts') }} ~{{ formatSpan(window.hoursLeft * 3600) }}
                  </span>
                  <span>· {{ t('ai.config.planRollsOver') }}: {{ formatSpan(window.rollsOverInSeconds) }}</span>
                </li>
                <li
                  v-if="smartState(provider.id)?.roomRatio !== null && smartState(provider.id)?.roomRatio !== undefined"
                  class="text-[0.78rem] tabular-nums text-muted flex flex-wrap items-baseline gap-x-2"
                >
                  <span class="font-semibold text-text">{{ t('ai.config.planRoom') }}</span>
                  <span>{{ smartState(provider.id)?.roomRatio?.toFixed(2) }}×</span>
                  <span class="text-[0.74rem]">
                    {{ (smartState(provider.id)?.roomRatio ?? 0) >= 1 ? t('ai.config.planRoomToSpare') : t('ai.config.planRoomTight') }}
                  </span>
                </li>
              </ul>

              <span
                v-else
                class="text-[0.78rem] tabular-nums text-muted"
              >
                <template v-if="smartState(provider.id)?.poolTotal">
                  {{ smartState(provider.id)?.poolUsed }} / {{ smartState(provider.id)?.poolTotal }}
                </template>
                <template v-else>
                  {{ smartState(provider.id)?.poolRemainingPercent }}% {{ t('ai.config.planLeft') }}
                </template>
                · {{ t('ai.config.ourUse') }}: {{ smartState(provider.id)?.ourUsage }}
                <span v-if="smartState(provider.id)?.resetsAt">
                  · {{ t('ai.config.resetsAt') }}: {{ formatDate(smartState(provider.id)?.resetsAt) }}
                </span>
              </span>
            </div>
          </div>

          <!-- What this provider has spent, and how close each window is. -->
          <ul
            v-if="providerUsage(provider.id)?.windows.length"
            class="m-0 p-0 list-none grid gap-[0.35rem]"
          >
            <li
              v-for="window in providerUsage(provider.id)?.windows"
              :key="window.hours"
              class="px-2.5 py-1.5 rounded-[0.45rem] border border-border bg-surface-alt flex items-center justify-between gap-3"
            >
              <span class="text-[0.78rem] font-semibold">
                {{ window.hours }}h · {{ window.percent }}%
              </span>
              <span class="text-[0.76rem] tabular-nums text-muted">
                {{ formatTokens(window.used) }} / {{ formatTokens(window.limit) }}
                <span v-if="window.limit > 0" class="ml-[0.3rem]">({{ Math.round(window.percent) }}%)</span>
              </span>
              <span
                v-if="window.overThreshold"
                class="text-[0.7rem] font-semibold px-[0.3rem] py-[0.12rem] rounded-[0.3rem] text-[#b42318] bg-[rgba(217,48,37,0.10)]"
              >
                {{ t('ai.config.limitReached') }}
              </span>
            </li>
          </ul>
        </div>

        <div class="flex items-center gap-[0.45rem]">
          <button
            type="button"
            class="inline-flex items-center gap-[0.35rem] px-3 py-[0.4rem] text-[0.76rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-hover text-text hover:bg-border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="testingId === index"
            @click="testProvider(provider, index)"
          >
            <span :class="testingId === index ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-plug-16-regular'" class="w-[0.9rem] h-[0.9rem]" aria-hidden="true" />
            {{ t('ai.config.test') }}
          </button>
          <button
            type="button"
            class="inline-flex items-center justify-center w-7 h-7 rounded-full border-0 bg-transparent text-[#b42318] cursor-pointer hover:bg-[rgba(217,48,37,0.08)]"
            :aria-label="t('ai.config.removeProvider')"
            :title="t('ai.config.removeProvider')"
            :disabled="providers.length <= 1"
            @click="removeProvider(index)"
          >
            <span class="i-fluent-delete-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
          </button>
          <span v-if="testResults[index]" class="text-[0.78rem]" :class="testResults[index].ok ? 'text-[#1f7a3a]' : 'text-[#b42318]'">
            {{ testResults[index].ok
              ? t('ai.config.testOk', { count: testResults[index].modelCount ?? 0 })
              : t('ai.config.testFailed', { message: testResults[index].message ?? testResults[index].status ?? '—' }) }}
          </span>
        </div>
      </div>
    </div>

    <!-- ---------- stages ---------- -->
    <div class="flex flex-col gap-3">
      <h3 class="m-0 text-[0.95rem]">{{ t('ai.config.stages') }}</h3>
      <p class="m-0 text-[0.8rem] text-muted">{{ t('ai.config.stagesHint') }}</p>

      <!-- ---------- vision ---------- -->
      <div class="grid gap-2 px-3 py-3 rounded-[0.55rem] border border-border bg-surface-alt">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-[0.8rem] font-semibold">{{ t('ai.config.stageVision') }}</span>
          <span class="text-[0.72rem] text-muted">{{ t('ai.config.stageVisionHint') }}</span>
        </div>
        <div class="grid gap-2 sm:grid-cols-4 items-end">
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.provider') }}
            </span>
            <select v-model="stages.vision.providerId" class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.model') }}
            </span>
            <AiModelSelect
              v-model="stages.vision.model"
              :provider-id="stages.vision.providerId"
              :placeholder="t('ai.config.providerDefault')"
              :default-model="providerDefault(stages.vision.providerId)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.maxTokens') }}
            </span>
            <input
              v-model.number="stages.vision.maxTokens"
              type="number"
              min="128"
              class="px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.timeout') }} (ms)
            </span>
            <input
              v-model.number="stages.vision.timeoutMs"
              type="number"
              min="1000"
              step="1000"
              class="px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
            />
          </label>
        </div>
        <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
          <input v-model="stages.vision.jsonMode" type="checkbox" class="accent-current" />
          <span>{{ t('ai.config.jsonMode') }}</span>
        </label>
      </div>

      <!-- ---------- audio ---------- -->
      <div class="grid gap-2 px-3 py-3 rounded-[0.55rem] border border-border bg-surface-alt">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-[0.8rem] font-semibold">{{ t('ai.config.stageAudio') }}</span>
          <span class="text-[0.72rem] text-muted">{{ t('ai.config.stageAudioHint') }}</span>
        </div>
        <div class="grid gap-2 sm:grid-cols-4 items-end">
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.provider') }}
            </span>
            <select v-model="stages.audio.providerId" class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.model') }}
            </span>
            <AiModelSelect
              v-model="stages.audio.model"
              :provider-id="stages.audio.providerId"
              :placeholder="t('ai.config.providerDefault')"
              :default-model="providerDefault(stages.audio.providerId)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.language') }}
            </span>
            <input
              v-model="stages.audio.language"
              type="text"
              placeholder="auto"
              class="px-2.5 py-[0.4rem] text-[0.85rem] font-mono bg-surface border border-border rounded text-text"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.timeout') }} (ms)
            </span>
            <input
              v-model.number="stages.audio.timeoutMs"
              type="number"
              min="1000"
              step="1000"
              class="px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
            />
          </label>
        </div>
      </div>

      <!-- ---------- embeddings ---------- -->
      <div class="grid gap-2 px-3 py-3 rounded-[0.55rem] border border-border bg-surface-alt">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-[0.8rem] font-semibold">{{ t('ai.config.stageEmbed') }}</span>
          <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
            <input v-model="stages.embed.enabled" type="checkbox" class="accent-current" />
            <span>{{ t('ai.config.enabled') }}</span>
          </label>
        </div>
        <div class="grid gap-2 sm:grid-cols-3 items-end">
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.provider') }}
            </span>
            <select v-model="stages.embed.providerId" class="px-2.5 py-[0.4rem] text-[0.85rem] bg-surface border border-border rounded text-text">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.model') }}
            </span>
            <AiModelSelect
              v-model="stages.embed.model"
              :provider-id="stages.embed.providerId"
              :placeholder="t('ai.config.providerDefault')"
              :default-model="providerDefault(stages.embed.providerId)"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.timeout') }} (ms)
            </span>
            <input
              v-model.number="stages.embed.timeoutMs"
              type="number"
              min="1000"
              step="1000"
              class="px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
            />
          </label>
        </div>
      </div>

      <!-- ---------- canonicalizer ---------- -->
      <div class="grid gap-2 px-3 py-3 rounded-[0.55rem] border border-border bg-surface-alt">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-[0.8rem] font-semibold">{{ t('ai.config.stageCanonicalizer') }}</span>
          <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
            <input v-model="stages.canonicalizer.enabled" type="checkbox" class="accent-current" />
            <span>{{ t('ai.config.enabled') }}</span>
          </label>
        </div>
        <div class="grid gap-2 sm:grid-cols-3 items-end">
          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.serviceUrl') }}
            </span>
            <input
              v-model="stages.canonicalizer.url"
              type="text"
              placeholder="http://10.0.2.31:11123"
              class="px-2.5 py-[0.4rem] text-[0.85rem] font-mono bg-surface border border-border rounded text-text"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[0.7rem] font-bold tracking-[0.06em] text-muted uppercase">
              {{ t('ai.config.timeout') }} (ms)
            </span>
            <input
              v-model.number="stages.canonicalizer.timeoutMs"
              type="number"
              min="1000"
              step="1000"
              class="px-2.5 py-[0.4rem] text-[0.85rem] tabular-nums bg-surface border border-border rounded text-text"
            />
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label class="inline-flex items-center gap-[0.4rem] text-[0.82rem] cursor-pointer">
            <input v-model="stages.canonicalizer.verify" type="checkbox" class="accent-current" />
            <span>{{ t('ai.config.verifyCanonicalization') }}</span>
          </label>
          <span class="text-[0.75rem] text-muted">{{ t('ai.config.canonicalizerHint') }}</span>
        </div>
      </div>
    </div>

    <!-- ---------- domain canonicalization ---------- -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="m-0 text-[0.95rem]">{{ t('ai.config.canonicalization') }}</h3>
          <p class="m-0 mt-[0.15rem] text-[0.8rem] text-muted">
            {{ t('ai.config.canonicalizationSubtitle') }}
          </p>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-[0.35rem] self-start px-3 py-[0.4rem] text-[0.76rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-surface-alt text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="canonicalizationBusy || canonicalization.running"
          @click="runCanonicalization"
        >
          <span
            :class="canonicalizationBusy || canonicalization.running ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-reset-16-regular'"
            class="w-[0.9rem] h-[0.9rem]"
            aria-hidden="true"
          />
          {{ t('ai.config.recheckDomains') }}
        </button>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-3 gap-[0.75rem]">
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('ai.config.domainCount') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">
            {{ formatNumber(canonicalization.domains) }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('ai.config.rechecked') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">
            {{ formatNumber(canonicalization.checked) }}
          </span>
        </div>
        <div>
          <span class="block text-[0.7rem] font-bold tracking-[0.08em] text-muted uppercase">
            {{ t('ai.config.moved') }}
          </span>
          <span class="block mt-[0.15rem] text-[1.4rem] font-medium tabular-nums">
            {{ formatNumber(canonicalization.moved) }}
          </span>
        </div>
      </div>

      <p v-if="canonicalization.error" class="m-0 text-[0.84rem] text-[#b42318]">
        {{ canonicalization.error }}
      </p>

      <ul v-if="canonicalization.log.length" class="m-0 p-0 list-none flex flex-col gap-[0.1rem]">
        <li
          v-for="(line, index) in canonicalization.log.slice(-6)"
          :key="index"
          class="text-[0.76rem] text-muted font-mono truncate"
        >
          {{ line }}
        </li>
      </ul>
    </div>

    <div class="flex items-center gap-[0.6rem] pt-[0.3rem] border-t border-border">
      <button
        type="button"
        class="inline-flex items-center gap-[0.35rem] px-3 py-[0.5rem] text-[0.78rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-text text-bg hover:opacity-90 transition-opacity cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="saving"
        @click="save"
      >
        <span :class="saving ? 'i-fluent-arrow-sync-16-filled animate-spin' : 'i-fluent-arrow-save-16-regular'" class="w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
        {{ saving ? t('ai.config.saving') : t('ai.config.save') }}
      </button>
    </div>
  </section>
</template>
<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import AiModelSelect from './AiModelSelect.vue';
import {
  fetchAiCanonicalization,
  fetchAiConfig,
  runAiCanonicalization,
  saveAiConfig,
  testAiProvider,
  type AiAnalysisConfig,
  type AiCanonicalizationState,
  type AiProviderInput,
  type AiProviderTestResult,
  type AiSmartProviderState,
  type AiUsageStatus,
} from '../api/ai-analysis';

/** The provider as the form holds it: the view fields plus a writable key. */
interface ProviderForm {
  id: string;
  label: string;
  dialect: 'openai-compatible' | 'minimax';
  baseUrl: string;
  defaultModel: string;
  /** The key as typed. Empty means "keep the stored one". */
  apiKey: string;
  reasoningEffort: string;
  thinkingType: string;
  /** This provider's own usage limits. */
  usageLimits: {
    enabled: boolean;
    budget: number;
    windows: { hours: number; percent: number }[];
    /** Which rule decides when the queue stops. */
    mode: 'hard' | 'smart';
    /** The smart mode's settings. */
    smart: {
      probeUrl: string;
      /** The key as typed. Empty means "keep the stored one". */
      probeApiKey: string;
      hasProbeApiKey: boolean;
      probeApiKeyMasked: string;
      watch: 'interval' | 'weekly' | 'both';
      pollMinutes: number;
      idlePercent: number;
      yieldPercent: number;
      contentionPercent: number;
      ignoreHardWindows: boolean;
    };
  };
  hasApiKey: boolean;
  apiKeyMasked: string;
}

/** The smart settings a fresh provider starts with. */
function emptySmartUsage() {
  return {
    probeUrl: '',
    probeApiKey: '',
    hasProbeApiKey: false,
    probeApiKeyMasked: '',
    watch: 'interval' as const,
    pollMinutes: 2,
    idlePercent: 100,
    yieldPercent: 0,
    contentionPercent: 5,
    ignoreHardWindows: false,
  };
}

/** The windows a usage limit can be set for. */
type UsageWindow = 'hourly' | 'daily' | 'weekly' | 'monthly';

const usageWindows: UsageWindow[] = ['hourly', 'daily', 'weekly', 'monthly'];

const { t, locale } = useI18n();

const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const configErrors = ref<string[]>([]);
const testingId = ref<number | null>(null);
const testResults = ref<Record<number, AiProviderTestResult>>({});
const usageStatus = ref<AiUsageStatus | null>(null);
/** The providers the page was loaded with. */
const loadedProviderIds = ref<string[]>([]);
/** What the smart mode says about each shared plan. */
const smartStates = ref<AiSmartProviderState[]>([]);
const canonicalization = ref<AiCanonicalizationState>({
  running: false,
  checked: 0,
  moved: 0,
  domains: 0,
  lastRunAt: null,
  error: null,
  log: [],
});
const canonicalizationBusy = ref(false);

const providers = ref<ProviderForm[]>([]);

const stages = reactive({
  vision: { providerId: '', model: '', maxTokens: 2000, timeoutMs: 120000, jsonMode: true },
  audio: { providerId: '', model: '', timeoutMs: 300000, language: null as string | null },
  embed: { providerId: '', model: '', enabled: false, timeoutMs: 60000 },
  canonicalizer: { enabled: true, url: '', timeoutMs: 30000, verify: true },
});

const pipeline = reactive({
  frameCount: 3,
  framePositions: [0.1, 0.5, 0.95] as number[],
  extractAudio: true,
  writeCaption: true,
  updateKnowledgeGraph: true,
  minDurationSeconds: 0,
  maxDurationSeconds: 0,
});



/** Token counts, abbreviated. */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** The frame positions as text — the form edits them as a comma-separated list. */
const framePositionsText = ref('0.1, 0.5, 0.95');

watch(framePositionsText, (text) => {
  const parsed = text
    .split(',')
    .map((part) => Number.parseFloat(part.trim()))
    .filter((value) => Number.isFinite(value));
  if (parsed.length > 0) pipeline.framePositions = parsed;
});

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

function applyConfig(config: AiAnalysisConfig) {
  // The providers that were loaded are remembered, so a provider removed from
  // this page can be named on the way out. A provider that is merely left
  // out is kept by the server — a stale page must not delete it.
  loadedProviderIds.value = config.providers.map((provider) => provider.id);
  providers.value = config.providers.map((provider) => ({
    id: provider.id,
    label: provider.label,
    dialect: provider.dialect,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiKey: '',
    reasoningEffort: provider.reasoningEffort ?? '',
    thinkingType: provider.thinkingType ?? '',
    usageLimits: {
      enabled: provider.usageLimits?.enabled ?? false,
      budget: provider.usageLimits?.budget ?? 0,
      windows: (provider.usageLimits?.windows ?? []).map((window) => ({
        hours: window.hours,
        percent: window.percent
      })),
      mode: provider.usageLimits?.mode ?? 'hard',
      smart: {
        ...emptySmartUsage(),
        probeUrl: provider.usageLimits?.smart?.probeUrl ?? '',
        hasProbeApiKey: provider.usageLimits?.smart?.hasProbeApiKey ?? false,
        probeApiKeyMasked: provider.usageLimits?.smart?.probeApiKeyMasked ?? '',
        watch: provider.usageLimits?.smart?.watch ?? 'interval',
        pollMinutes: provider.usageLimits?.smart?.pollMinutes ?? 2,
        idlePercent: provider.usageLimits?.smart?.idlePercent ?? 100,
        yieldPercent: provider.usageLimits?.smart?.yieldPercent ?? 0,
        contentionPercent: provider.usageLimits?.smart?.contentionPercent ?? 5,
        ignoreHardWindows: provider.usageLimits?.smart?.ignoreHardWindows ?? false,
      },
    },
    hasApiKey: provider.hasApiKey,
    apiKeyMasked: provider.apiKeyMasked,
  }));

  stages.vision = { ...config.stages.vision };
  stages.audio = { ...config.stages.audio };
  stages.embed = { ...config.stages.embed };
  stages.canonicalizer = { ...config.stages.canonicalizer };

  pipeline.frameCount = config.pipeline.frameCount;
  pipeline.framePositions = [...config.pipeline.framePositions];
  pipeline.extractAudio = config.pipeline.extractAudio;
  pipeline.writeCaption = config.pipeline.writeCaption;
  pipeline.updateKnowledgeGraph = config.pipeline.updateKnowledgeGraph;
  pipeline.minDurationSeconds = config.pipeline.minDurationSeconds;
  pipeline.maxDurationSeconds = config.pipeline.maxDurationSeconds;



  framePositionsText.value = config.pipeline.framePositions.join(', ');
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const result = await fetchAiConfig();
    applyConfig(result.config);
    configErrors.value = result.errors ?? [];
    usageStatus.value = result.usage ?? null;
    smartStates.value = result.smart ?? [];
    await refreshCanonicalization();
  } catch (e) {
    error.value = messageOf(e, t('ai.config.loadFailed'));
  } finally {
    loading.value = false;
  }
}

async function refreshCanonicalization() {
  try {
    const result = await fetchAiCanonicalization();
    canonicalization.value = result.state;
  } catch {
    // The canonicalizer may be off; the card simply stays empty.
  }
}

async function runCanonicalization() {
  canonicalizationBusy.value = true;
  error.value = null;
  try {
    const result = await runAiCanonicalization(200);
    canonicalization.value = result.state;
  } catch (e) {
    error.value = messageOf(e, t('ai.config.recheckFailed'));
  } finally {
    canonicalizationBusy.value = false;
  }
}

/** A number, for the counters. */
function formatNumber(value: number): string {
  return new Intl.NumberFormat(locale.value).format(value);
}

/** The default model of a provider, so the empty choice says what it means. */
function providerDefault(providerId: string): string {
  return providers.value.find((provider) => provider.id === providerId)?.defaultModel ?? '';
}

/** What the smart mode says about one provider's plan. */
function smartState(providerId: string): AiSmartProviderState | null {
  return smartStates.value.find((entry) => entry.providerId === providerId) ?? null;
}

/** A moment as a readable date and time. */
function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale.value);
}

/**
 * A span of time as a short, readable length: "3 d 4 h", "2 h 10 m", "45 s".
 *
 * The plan's windows are hours and days long, so a clock would be no use.
 */
function formatSpan(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return '—';
  }

  const total = Math.round(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);

  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} m`;
  return `${Math.max(1, minutes)} m`;
}

/** What one provider has spent. */
function providerUsage(providerId: string) {
  return usageStatus.value?.providers.find((entry) => entry.providerId === providerId) ?? null;
}

/** Add a usage window to a provider. */
function addUsageWindow(provider: ProviderForm) {
  provider.usageLimits.windows.push({ hours: 24, percent: 50 });
}

/** Remove a usage window from a provider. */
function removeUsageWindow(provider: ProviderForm, index: number) {
  provider.usageLimits.windows.splice(index, 1);
}

function addProvider() {
  providers.value.push({
    id: '',
    label: t('ai.config.newProvider'),
    dialect: 'openai-compatible',
    baseUrl: '',
    defaultModel: '',
    apiKey: '',
    reasoningEffort: '',
    thinkingType: '',
    usageLimits: {
      enabled: false,
      budget: 0,
      windows: [],
      mode: 'hard',
      smart: emptySmartUsage(),
    },
    hasApiKey: false,
    apiKeyMasked: '',
  });
}

/**
 * Add a MiniMax provider.
 *
 * The server reaches `api.minimax.io` directly, so the provider needs no
 * gateway — only the API key.
 */
function addMiniMaxProvider() {
  providers.value.push({
    id: 'minimax',
    label: 'MiniMax',
    dialect: 'minimax',
    baseUrl: 'https://api.minimax.io/v1',
    defaultModel: 'MiniMax-M3',
    apiKey: '',
    reasoningEffort: '',
    thinkingType: '',
    usageLimits: {
      enabled: false,
      budget: 0,
      windows: [],
      mode: 'hard',
      smart: emptySmartUsage(),
    },
    hasApiKey: false,
    apiKeyMasked: '',
  });
}

function removeProvider(index: number) {
  if (providers.value.length <= 1) return;
  providers.value.splice(index, 1);
}

async function testProvider(provider: ProviderForm, index: number) {
  testingId.value = index;
  try {
    const result = await testAiProvider(toInput(provider));
    testResults.value = { ...testResults.value, [index]: result };
  } catch (e) {
    testResults.value = {
      ...testResults.value,
      [index]: { ok: false, status: null, message: messageOf(e, t('ai.config.testFailedGeneric')) },
    };
  } finally {
    testingId.value = null;
  }
}

/** The provider as the API expects it. */
function toInput(provider: ProviderForm): AiProviderInput {
  const input: AiProviderInput = {
    id: provider.id,
    label: provider.label,
    dialect: provider.dialect,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    headers: {},
    reasoningEffort: provider.reasoningEffort,
    thinkingType: provider.thinkingType,
    usageLimits: {
      enabled: provider.usageLimits.enabled,
      budget: provider.usageLimits.budget,
      windows: provider.usageLimits.windows.map((window) => ({
        hours: window.hours,
        percent: window.percent
      })),
      mode: provider.usageLimits.mode,
      smart: {
        probeUrl: provider.usageLimits.smart.probeUrl,
        watch: provider.usageLimits.smart.watch,
        pollMinutes: provider.usageLimits.smart.pollMinutes,
        idlePercent: provider.usageLimits.smart.idlePercent,
        yieldPercent: provider.usageLimits.smart.yieldPercent,
        contentionPercent: provider.usageLimits.smart.contentionPercent,
        ignoreHardWindows: provider.usageLimits.smart.ignoreHardWindows,
      },
    },
  };
  // An untouched key field means "keep the stored one"; a typed one replaces
  // it. An emptied field on a provider that has a key would clear it, which
  // is what the admin asked for by clearing it.
  if (provider.apiKey !== '') input.apiKey = provider.apiKey;
  if (provider.usageLimits.smart.probeApiKey !== '') {
    input.usageLimits!.smart.probeApiKey = provider.usageLimits.smart.probeApiKey;
  }
  return input;
}

async function save() {
  saving.value = true;
  error.value = null;
  notice.value = null;
  try {
    const result = await saveAiConfig({
      providers: providers.value.map(toInput),
      // The providers that were loaded and are gone now are named, so they
      // are actually deleted. The ones that are merely not in this list are
      // left alone by the server.
      removeProviders: loadedProviderIds.value.filter(
        (id) => !providers.value.some((provider) => provider.id === id)
      ),
      stages: {
        vision: { ...stages.vision },
        audio: { ...stages.audio },
        embed: { ...stages.embed },
        canonicalizer: { ...stages.canonicalizer },
      },
      pipeline: { ...pipeline, framePositions: [...pipeline.framePositions] },
    });
    applyConfig(result.config);
    configErrors.value = result.errors ?? [];
    usageStatus.value = result.usage ?? null;
    smartStates.value = result.smart ?? [];
    notice.value = result.errors?.length
      ? t('ai.config.savedWithProblems')
      : t('ai.config.saved');
  } catch (e) {
    error.value = messageOf(e, t('ai.config.saveFailed'));
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void refresh();
});
</script>
