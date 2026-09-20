<template>
  <div class="fixed inset-0 z-60 flex items-center justify-center p-6 bg-black/55" @click.self="$emit('cancel')">
    <section class="w-[min(100%,32rem)] p-[1.4rem] bg-surface border border-border rounded-[1.2rem] shadow-[var(--shadow)]" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <div class="grid gap-[1.2rem]">
        <h2 :id="titleId" class="m-0 text-[1.25rem] font-semibold">{{ t('folder.profileModal.title') }}</h2>

        <FolderAiSummary v-if="folderId != null" :folder-id="folderId" :show-empty-state="true" />

        <form @submit.prevent="submit" class="grid gap-[1.1rem]">
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
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import FolderAiSummary from './FolderAiSummary.vue';

const props = defineProps<{
  initialName: string;
  initialDescription: string | null;
  error?: string | null;
  loading?: boolean;
  folderId?: number | null;
}>();

const emit = defineEmits<{
  cancel: [];
  save: [data: { name: string; description: string | null }];
}>();

const { t } = useI18n();
const titleId = `profile-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const validationError = ref<string | null>(null);

const formData = reactive({
  name: props.initialName,
  description: props.initialDescription ?? ''
});

const errorMessage = computed(() => validationError.value ?? props.error ?? null);

function submit() {
  if (!formData.name.trim()) {
    validationError.value = t('folder.profileModal.errors.nameRequired');
    return;
  }

  validationError.value = null;
  emit('save', {
    name: formData.name.trim(),
    description: formData.description.trim() || null
  });
}
</script>
