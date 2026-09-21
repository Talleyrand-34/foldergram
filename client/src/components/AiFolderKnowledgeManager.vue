<!--
  AiFolderKnowledgeManager — Settings panel for the per-folder AI rollup.

  Combines a list (every folder that has an AI rollup) with an inline
  editor for the selected folder. Each row in the list shows:
    folder name · analyzed/total · has override indicator · summary preview

  Click a row → that folder becomes the selection. The editor below
  pre-fills summary / domains / language from the rollup. Saving writes
  via the existing PATCH /api/folders/:slug endpoint with aiOverride in
  the body.

  Mounted in Settings below the Domain manager. Admin-gated like the
  other AI surfaces.
-->

<template>
  <section class="card p-5 md:p-6 flex flex-col gap-4">
    <header class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
      <div>
        <span class="eyebrow">{{ t('ai.folders.heading') }}</span>
        <h2 class="m-0 text-[1.1rem]">{{ t('ai.folders.title') }}</h2>
        <p class="m-0 mt-[0.15rem] text-muted text-[0.86rem]">
          {{ t('ai.folders.subtitle') }}
        </p>
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

    <div v-else-if="rows.length === 0 && !loading" class="text-[0.88rem] text-muted italic">
      {{ t('ai.folders.empty') }}
    </div>

    <div v-else class="grid gap-[0.4rem] max-h-[18rem] overflow-y-auto">
      <button
        v-for="r in rows"
        :key="r.folderId"
        type="button"
        class="grid grid-cols-[1fr_auto] items-center gap-[0.55rem] px-[0.75rem] py-[0.5rem] rounded-[0.55rem] border bg-surface-alt text-left cursor-pointer transition-colors duration-120 hover:bg-surface-hover"
        :class="r.folderId === selectedId ? 'border-accent bg-accent/8' : 'border-border'"
        @click="select(r)"
      >
        <div class="grid gap-[0.05rem] min-w-0">
          <span class="flex items-center gap-[0.45rem]">
            <span class="font-semibold text-[0.92rem] text-text truncate">{{ r.folderName }}</span>
            <span v-if="r.hasUserOverride" class="inline-flex items-center gap-[0.3rem] px-[0.4rem] py-[0.05rem] text-[0.7rem] font-medium rounded-full border border-accent/40 bg-accent/10 text-accent">
              <span class="i-fluent-sparkle-12-filled w-[0.7rem] h-[0.7rem]" aria-hidden="true" />
              {{ t('ai.folders.overrideBadge') }}
            </span>
          </span>
          <span class="text-[0.74rem] text-muted tabular-nums">
            {{ r.analyzedCount }} / {{ r.videoCount }} {{ t('ai.folders.analyzed') }} ·
            <span v-if="r.topDomains.length > 0" class="font-mono">{{ r.topDomains.slice(0, 3).join(' · ') }}</span>
            <span v-else>—</span>
            <span v-if="r.language" class="ml-[0.45rem] font-mono">{{ r.language.toUpperCase() }}</span>
          </span>
          <span v-if="r.summary" class="text-[0.78rem] text-text/85 line-clamp-2 leading-[1.4]">{{ r.summary }}</span>
        </div>
        <span
          class="text-[0.78rem] text-muted shrink-0"
          :class="r.folderId === selectedId ? 'i-fluent-checkmark-20-filled text-accent' : 'i-fluent-chevron-right-20-regular'"
          aria-hidden="true"
        />
      </button>
    </div>

    <div v-if="selected" class="border-t border-border pt-[0.85rem] grid gap-[0.6rem]">
      <header class="flex items-center gap-[0.5rem]">
        <span class="i-fluent-sparkle-16-regular text-accent w-[1rem] h-[1rem]" aria-hidden="true" />
        <span class="font-semibold text-[0.92rem] text-text">{{ selected.folderName }}</span>
        <span class="text-[0.72rem] text-muted font-mono">{{ selected.folderPath }}</span>
      </header>

      <div class="grid gap-[0.35rem]">
        <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.folders.summary') }}
        </span>
        <p v-if="effectiveSummary" class="m-0 text-[0.88rem] text-text leading-[1.45] px-[0.7rem] py-[0.55rem] rounded-[0.55rem] border border-border bg-surface-alt">
          {{ effectiveSummary }}
        </p>
        <p v-else class="m-0 text-[0.86rem] text-muted italic">
          {{ t('ai.folders.noSummary') }}
        </p>
      </div>

      <div class="grid gap-[0.35rem]">
        <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.folders.yourOverride') }}
        </span>
        <textarea
          v-model="overrideSummary"
          class="w-full min-h-[4.5rem] rounded-lg border border-border bg-surface px-[0.75rem] py-[0.55rem] text-[0.88rem] text-text placeholder-muted resize-y focus:border-text focus:outline-none focus:ring-1 focus:ring-text"
          :placeholder="t('ai.folders.summaryPlaceholder')"
          maxlength="500"
        ></textarea>
      </div>

      <div class="grid gap-[0.35rem]">
        <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.folders.domains') }}
        </span>
        <EditableChipInput
          v-model="overrideDomains"
          :suggestions="domainSuggestions"
          :placeholder="t('ai.folders.domainsPlaceholder')"
          :add-label="t('ai.folders.add')"
          :max-items="20"
          :normalize="(v) => v.toLowerCase().trim()"
          :validate="validateDomain"
        />
      </div>

      <div class="grid gap-[0.35rem]">
        <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
          {{ t('ai.folders.language') }}
        </span>
        <EditableChipInput
          v-model="overrideLanguage"
          mode="single"
          :suggestions="languageSuggestions"
          :placeholder="t('ai.folders.languagePlaceholder')"
          :add-label="t('ai.folders.add')"
          :normalize="(v) => v.toLowerCase().trim()"
          :validate="validateLanguage"
        />
      </div>

      <div class="flex items-center gap-[0.5rem] mt-[0.3rem]">
        <button
          v-if="selected.hasUserOverride"
          type="button"
          class="px-[0.7rem] py-[0.45rem] text-[0.78rem] text-muted hover:text-text underline-offset-2 hover:underline"
          @click="clearOverrides"
        >
          {{ t('ai.folders.resetOverride') }}
        </button>
        <span class="flex-1"></span>
        <button
          type="button"
          class="inline-flex items-center px-[1rem] py-[0.55rem] text-[0.85rem] font-semibold border border-border rounded-lg bg-surface-hover text-text hover:bg-border cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="saving"
          @click="cancel"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center px-[1rem] py-[0.55rem] text-[0.85rem] font-semibold border border-border rounded-lg bg-text text-bg hover:opacity-90 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? t('common.saving') : t('common.save') }}
        </button>
      </div>

      <p v-if="actionError" class="m-0 text-[0.78rem] text-[#b42318]">{{ actionError }}</p>
      <p v-if="actionOk" class="m-0 text-[0.78rem] text-[#1f7a3a]">{{ actionOk }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import EditableChipInput from './EditableChipInput.vue';
import {
  fetchDistinctLanguages,
  fetchFolderRollup,
  fetchFoldersWithRollup,
  fetchTopDomainStrings as fetchTopDomains,
  updateFolderProfileAiOverride,
  type FolderKnowledgeRow,
  type FolderRollup,
} from '../api/ai-analysis';

const { t } = useI18n();

const rows = ref<FolderKnowledgeRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const selectedId = ref<number | null>(null);
const rollup = ref<FolderRollup | null>(null);
const rollupLoading = ref(false);

const overrideSummary = ref('');
const overrideDomains = ref<string[]>([]);
const overrideLanguage = ref<string>('');

const domainSuggestions = ref<string[]>([]);
const languageSuggestions = ref<string[]>([]);

const saving = ref(false);
const actionError = ref<string | null>(null);
const actionOk = ref<string | null>(null);

const selected = computed<FolderKnowledgeRow | null>(() => {
  if (selectedId.value === null) return null;
  return rows.value.find((r) => r.folderId === selectedId.value) ?? null;
});

const effectiveSummary = computed(() => {
  const r = rollup.value;
  if (!r) return null;
  return r.userSummary ?? r.summary;
});

function validateDomain(v: string): string | null {
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(v)) {
    return 'lowercase, digits, /, - only';
  }
  return null;
}
function validateLanguage(v: string): string | null {
  if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(v)) {
    return 'use ISO code like es, en, pt-br';
  }
  return null;
}

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await fetchFoldersWithRollup();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('ai.status.error');
  } finally {
    loading.value = false;
  }
}

async function loadSuggestions() {
  const [domains, languages] = await Promise.all([
    fetchTopDomains().catch(() => []),
    fetchDistinctLanguages().catch(() => []),
  ]);
  domainSuggestions.value = domains;
  languageSuggestions.value = languages;
}

async function select(row: FolderKnowledgeRow) {
  selectedId.value = row.folderId;
  actionError.value = null;
  actionOk.value = null;
  rollupLoading.value = true;
  try {
    const r = await fetchFolderRollup(row.folderId);
    rollup.value = r;
    overrideSummary.value = r?.userSummary ?? '';
    overrideDomains.value = [...(r?.userDomains ?? [])];
    overrideLanguage.value = r?.userLanguage ?? '';
  } catch {
    rollup.value = null;
  } finally {
    rollupLoading.value = false;
  }
}

function clearOverrides() {
  overrideSummary.value = '';
  overrideDomains.value = [];
  overrideLanguage.value = '';
}

function cancel() {
  selectedId.value = null;
  rollup.value = null;
  actionError.value = null;
  actionOk.value = null;
}

async function save() {
  if (!selected.value) return;
  saving.value = true;
  actionError.value = null;
  actionOk.value = null;
  try {
    const ok = await updateFolderProfileAiOverride(selected.value.folderSlug, {
      userSummary: overrideSummary.value.trim() === '' ? null : overrideSummary.value.trim(),
      userDomains: overrideDomains.value.length === 0 ? null : overrideDomains.value,
      userLanguage: overrideLanguage.value.trim() === '' ? null : overrideLanguage.value.trim().toLowerCase(),
    });
    if (!ok) {
      actionError.value = t('ai.folders.saveFailed');
    } else {
      actionOk.value = t('ai.folders.saved');
      await select(selected.value);
      await refresh();
    }
  } catch {
    actionError.value = t('ai.folders.saveFailed');
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadSuggestions()]);
});

// Keep suggestions fresh if the user re-renders
watch(domainSuggestions, (v) => { if (v.length === 0) void loadSuggestions(); });
</script>
