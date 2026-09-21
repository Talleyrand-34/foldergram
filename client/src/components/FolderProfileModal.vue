<template>
  <div class="fixed inset-0 z-60 flex items-center justify-center p-6 bg-black/55" @click.self="$emit('cancel')">
    <section class="w-[min(100%,32rem)] p-[1.4rem] bg-surface border border-border rounded-[1.2rem] shadow-[var(--shadow)]" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <div class="grid gap-[1.2rem]">
        <h2 :id="titleId" class="m-0 text-[1.25rem] font-semibold">{{ t('folder.profileModal.title') }}</h2>

        <FolderAiSummary v-if="folderId != null" :folder-id="folderId" :show-empty-state="true" />

        <form v-if="folderId != null" @submit.prevent="submit" class="grid gap-[1.1rem]">
          <div v-if="hasAiData" class="grid gap-[0.6rem] pt-[0.2rem]">
            <div class="flex items-center justify-between">
              <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
                {{ t('folder.profileModal.overrideLabel') }}
              </span>
              <button
                v-if="hasAnyOverride"
                type="button"
                class="text-[0.74rem] text-muted hover:text-text underline-offset-2 hover:underline"
                @click.prevent="clearOverrides"
              >
                {{ t('folder.profileModal.resetOverride') }}
              </button>
            </div>

            <div class="grid gap-[0.35rem]">
              <label :for="`${titleId}-summary`" class="text-[0.78rem] font-semibold text-muted">
                {{ t('folder.profileModal.overrideSummary') }}
              </label>
              <textarea
                :id="`${titleId}-summary`"
                v-model="overrideSummary"
                class="w-full min-h-[4.5rem] rounded-lg border border-border bg-surface px-[0.75rem] py-[0.55rem] text-[0.88rem] text-text placeholder-muted resize-y focus:border-text focus:outline-none focus:ring-1 focus:ring-text"
                :placeholder="t('folder.profileModal.overrideSummaryPlaceholder')"
                maxlength="500"
              ></textarea>
              <p v-if="aiSummary" class="m-0 text-[0.72rem] text-muted italic">
                {{ t('folder.profileModal.aiSaid') }}: {{ aiSummary }}
              </p>
            </div>

            <div class="grid gap-[0.35rem]">
              <label class="text-[0.78rem] font-semibold text-muted">
                {{ t('folder.profileModal.overrideDomains') }}
              </label>
              <EditableChipInput
                v-model="overrideDomains"
                :suggestions="domainSuggestions"
                :placeholder="t('folder.profileModal.overrideDomainsPlaceholder')"
                :add-label="t('folder.profileModal.overrideAdd')"
                :max-items="20"
                :normalize="(v) => v.toLowerCase().trim()"
                :validate="validateDomain"
              />
              <p v-if="aiDomains.length > 0" class="m-0 text-[0.72rem] text-muted italic">
                {{ t('folder.profileModal.aiSaid') }}:
                <span v-for="(d, i) in aiDomains" :key="d">
                  <span class="font-mono">{{ d }}</span><span v-if="i < aiDomains.length - 1">, </span>
                </span>
              </p>
            </div>

            <div class="grid gap-[0.35rem]">
              <label class="text-[0.78rem] font-semibold text-muted">
                {{ t('folder.profileModal.overrideLanguage') }}
              </label>
              <EditableChipInput
                v-model="overrideLanguage"
                mode="single"
                :suggestions="languageSuggestions"
                :placeholder="t('folder.profileModal.overrideLanguagePlaceholder')"
                :add-label="t('folder.profileModal.overrideAdd')"
                :normalize="(v) => v.toLowerCase().trim()"
                :validate="validateLanguage"
              />
              <p v-if="aiLanguage" class="m-0 text-[0.72rem] text-muted italic">
                {{ t('folder.profileModal.aiSaid') }}: <span class="font-mono">{{ aiLanguage }}</span>
              </p>
            </div>
          </div>

          <div class="flex items-center gap-[0.65rem] pt-[0.4rem] border-t border-border">
            <span class="text-[0.78rem] font-semibold tracking-[0.06em] text-muted uppercase pt-[0.6rem]">
              {{ t('folder.profileModal.basicLabel') }}
            </span>
          </div>

          <div class="grid gap-[0.4rem]">
            <label for="profile-name" class="text-[0.85rem] font-semibold text-text">{{ t('common.name') }}</label>
            <input
              id="profile-name"
              v-model="formData.name"
              type="text"
              class="w-full px-3 py-2 text-[0.95rem] bg-bg border border-border rounded-lg text-text focus:outline-none focus:border-[#4B5563] transition-colors"
              required
              maxlength="255"
              :placeholder="t('folder.profileModal.namePlaceholder')"
            />
          </div>

          <div class="grid gap-[0.35rem]">
            <div class="flex items-center justify-between">
              <label for="profile-description" class="text-[0.85rem] font-semibold text-text">{{ t('common.description') }}</label>
              <span class="text-[0.75rem] text-muted">{{ formData.description?.length || 0 }} / 300</span>
            </div>
            <textarea
              id="profile-description"
              v-model="formData.description"
              class="w-full min-h-[6rem] rounded-lg border border-border bg-surface px-[0.75rem] py-[0.6rem] text-[0.95rem] text-text placeholder-muted resize-y focus:border-text focus:outline-none focus:ring-1 focus:ring-text"
              :placeholder="t('folder.profileModal.descriptionPlaceholder')"
              maxlength="300"
            ></textarea>
          </div>

          <p
            v-if="errorMessage"
            class="m-0 rounded-[0.95rem] border border-[rgba(214,48,49,0.24)] bg-[rgba(214,48,49,0.08)] px-4 py-3 text-[0.88rem] text-[#c0392b]"
          >
            {{ errorMessage }}
          </p>

          <div class="flex justify-end gap-3 mt-2">
            <button class="min-h-[2.5rem] px-4 py-[0.6rem] border border-transparent rounded-[0.75rem] font-semibold cursor-pointer bg-surface-hover text-text disabled:opacity-70 disabled:cursor-wait" type="button" @click="$emit('cancel')">
              {{ t('common.cancel') }}
            </button>
            <button class="min-h-[2.5rem] px-4 py-[0.6rem] border border-transparent rounded-[0.75rem] font-semibold cursor-pointer bg-text text-bg disabled:opacity-70 disabled:cursor-wait" type="submit" :disabled="loading">
              {{ loading ? t('common.saving') : t('common.save') }}
            </button>
          </div>
        </form>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import FolderAiSummary from './FolderAiSummary.vue';
import EditableChipInput from './EditableChipInput.vue';
import {
  fetchDistinctLanguages,
  fetchFolderRollup,
  fetchTopDomainStrings as fetchTopDomains,
  updateFolderRollup,
  type FolderRollup,
} from '../api/ai-analysis';

const props = defineProps<{
  initialName: string;
  initialDescription: string | null;
  error?: string | null;
  loading?: boolean;
  folderId?: number | null;
}>();

const emit = defineEmits<{
  cancel: [];
  save: [data: {
    name: string;
    description: string | null;
    override?: {
      userSummary?: string | null;
      userDomains?: string[] | null;
      userLanguage?: string | null;
    };
  }];
}>();

const { t } = useI18n();
const titleId = `profile-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const validationError = ref<string | null>(null);

const formData = reactive({
  name: props.initialName,
  description: props.initialDescription ?? ''
});

// --- AI rollup editing -------------------------------------------------
const rollup = ref<FolderRollup | null>(null);
const hasAiData = computed(() => !!rollup.value && rollup.value.analyzedCount > 0);
const overrideSummary = ref('');
const overrideDomains = ref<string[]>([]);
const overrideLanguage = ref<string>('');

const aiSummary = computed(() => rollup.value?.summary ?? '');
const aiDomains = computed(() => rollup.value?.topDomains ?? []);
const aiLanguage = computed(() => rollup.value?.language ?? '');

const domainSuggestions = ref<string[]>([]);
const languageSuggestions = ref<string[]>([]);

const hasAnyOverride = computed(() => {
  if (!rollup.value) return false;
  return !!rollup.value.userSummary
    || rollup.value.userDomains.length > 0
    || !!rollup.value.userLanguage;
});

function clearOverrides() {
  overrideSummary.value = '';
  overrideDomains.value = [];
  overrideLanguage.value = '';
}

function validateDomain(v: string): string | null {
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(v)) {
    return 'Use lowercase letters, digits, /, - (e.g. music/reggaeton)';
  }
  return null;
}
function validateLanguage(v: string): string | null {
  if (!/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(v)) {
    return 'Use ISO code like es, en, pt-br';
  }
  return null;
}

async function loadRollup() {
  if (props.folderId == null) return;
  try {
    const r = await fetchFolderRollup(props.folderId);
    rollup.value = r;
    overrideSummary.value = r?.userSummary ?? '';
    overrideDomains.value = [...(r?.userDomains ?? [])];
    overrideLanguage.value = r?.userLanguage ?? '';
  } catch {
    rollup.value = null;
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

onMounted(() => {
  void loadRollup();
  void loadSuggestions();
});
watch(() => props.folderId, loadRollup);
// --- end AI rollup ----------------------------------------------------

const errorMessage = computed(() => validationError.value ?? props.error ?? null);

function submit() {
  if (!formData.name.trim()) {
    validationError.value = t('folder.profileModal.errors.nameRequired');
    return;
  }

  validationError.value = null;

  // Collect the override only if the user touched any of the fields.
  // We treat an empty input as "clear this override" (null in payload).
  const override: { userSummary?: string | null; userDomains?: string[] | null; userLanguage?: string | null } = {};
  if (hasAiData.value) {
    override.userSummary = overrideSummary.value.trim() === '' ? null : overrideSummary.value.trim();
    override.userDomains = overrideDomains.value.length === 0 ? null : overrideDomains.value;
    override.userLanguage = overrideLanguage.value.trim() === '' ? null : overrideLanguage.value.trim().toLowerCase();
  }

  emit('save', {
    name: formData.name.trim(),
    description: formData.description.trim() || null,
    override: hasAiData.value ? override : undefined,
  });
}
</script>
