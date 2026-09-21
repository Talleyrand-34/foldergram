<!--
  AiDomainKnowledgeEditor — modal for editing a single domain's knowledge.

  Opens when the user clicks the knowledge icon on a domain row in the
  Domain manager. Lets the admin:
    - See the domain's stats (videos, folders, languages, AI summary preview)
    - Edit the human-authored description (free text, multi-line)
    - See which videos are currently tagged with this domain

  Saves via PATCH /knowledge/domains/:domain/description. Clearing the
  description (empty save) sets it to null.
-->

<template>
  <Teleport to="body">
    <div
      v-if="open && domain"
      class="fixed inset-0 z-60 flex items-center justify-center p-6 bg-black/55"
      @click.self="$emit('close')"
    >
      <section
        class="w-[min(100%,44rem)] max-h-[88vh] overflow-hidden flex flex-col bg-surface border border-border rounded-[1.2rem] shadow-[var(--shadow)]"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
      >
        <header class="flex items-start justify-between gap-4 px-[1.4rem] pt-[1.4rem] pb-[0.6rem]">
          <div>
            <span class="eyebrow">{{ t('ai.domainKnowledge.heading') }}</span>
            <h2 :id="titleId" class="m-0 mt-[0.15rem] font-mono text-[1.2rem] text-text">{{ domain.domain }}</h2>
            <p class="m-0 mt-[0.25rem] text-muted text-[0.82rem]">{{ t('ai.domainKnowledge.subtitle') }}</p>
          </div>
          <button
            type="button"
            class="inline-flex items-center justify-center w-9 h-9 rounded-full border-0 bg-transparent text-muted cursor-pointer hover:bg-surface-hover hover:text-text"
            :aria-label="t('common.cancel')"
            @click="$emit('close')"
          >
            <span class="i-fluent-dismiss-20-regular w-[1.15rem] h-[1.15rem]" aria-hidden="true" />
          </button>
        </header>

        <div class="flex-1 overflow-y-auto px-[1.4rem] pb-[1.4rem] grid gap-[1.1rem]">
          <section class="grid gap-[0.45rem]">
            <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
              {{ t('ai.domainKnowledge.stats') }}
            </span>
            <dl class="grid grid-cols-3 gap-[0.55rem] text-[0.82rem]">
              <div class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.65rem] py-[0.45rem]">
                <dt class="font-bold tracking-[0.04em] text-muted text-[0.7rem] uppercase">{{ t('ai.domainKnowledge.videos') }}</dt>
                <dd class="mt-[0.05rem] text-[1rem] tabular-nums">{{ domain.videoCount }}</dd>
              </div>
              <div class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.65rem] py-[0.45rem]">
                <dt class="font-bold tracking-[0.04em] text-muted text-[0.7rem] uppercase">{{ t('ai.domainKnowledge.folders') }}</dt>
                <dd class="mt-[0.05rem] text-[1rem] tabular-nums">{{ domain.folderCount }}</dd>
              </div>
              <div class="rounded-[0.55rem] border border-border bg-surface-alt px-[0.65rem] py-[0.45rem]">
                <dt class="font-bold tracking-[0.04em] text-muted text-[0.7rem] uppercase">{{ t('ai.domainKnowledge.languages') }}</dt>
                <dd class="mt-[0.05rem] text-[0.85rem] font-mono">{{ formattedLangs }}</dd>
              </div>
            </dl>
          </section>

          <section class="grid gap-[0.45rem]">
            <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
              {{ t('ai.domainKnowledge.knowledge') }}
            </span>
            <textarea
              ref="descriptionEl"
              v-model="descriptionDraft"
              class="w-full min-h-[7rem] rounded-lg border border-border bg-surface px-[0.75rem] py-[0.6rem] text-[0.92rem] leading-[1.5] text-text placeholder-muted resize-y focus:border-text focus:outline-none focus:ring-1 focus:ring-text"
              :placeholder="t('ai.domainKnowledge.knowledgePlaceholder')"
              maxlength="2000"
            ></textarea>
            <p class="m-0 text-[0.72rem] text-muted">
              {{ descriptionDraft.length }} / 2000
            </p>
          </section>

          <section class="grid gap-[0.45rem]">
            <header class="flex items-center gap-[0.5rem]">
              <span class="text-[0.78rem] font-bold tracking-[0.08em] text-muted uppercase">
                {{ t('ai.domainKnowledge.tagged') }}
              </span>
              <span class="text-[0.72rem] text-muted tabular-nums">{{ videos.length }}</span>
            </header>
            <div v-if="loadingVideos" class="text-[0.82rem] text-muted italic">
              {{ t('common.loading') }}
            </div>
            <div v-else-if="videos.length === 0" class="text-[0.82rem] text-muted italic">
              {{ t('ai.domainKnowledge.noTagged') }}
            </div>
            <div v-else class="grid gap-[0.35rem] max-h-[18rem] overflow-y-auto">
              <RouterLink
                v-for="v in videos"
                :key="v.id"
                :to="{ name: 'image', params: { id: String(v.id) } }"
                class="grid gap-[0.05rem] px-[0.7rem] py-[0.45rem] rounded-[0.5rem] border border-border bg-surface-alt no-underline transition-colors hover:bg-surface-hover"
                @click="$emit('close')"
              >
                <span class="flex items-center gap-[0.4rem]">
                  <span class="font-medium text-[0.86rem] text-text truncate">{{ v.filename }}</span>
                  <span v-if="v.aiLanguage" class="text-[0.7rem] font-mono text-muted uppercase">{{ v.aiLanguage }}</span>
                </span>
                <span class="text-[0.72rem] text-muted truncate">
                  {{ v.folderName }} · {{ v.relativePath }}
                </span>
                <span v-if="v.aiSummary" class="text-[0.78rem] text-text/85 line-clamp-1 italic">
                  {{ v.aiSummary }}
                </span>
              </RouterLink>
            </div>
          </section>

          <p v-if="actionError" class="m-0 text-[0.78rem] text-[#b42318]">{{ actionError }}</p>
          <p v-if="actionOk" class="m-0 text-[0.78rem] text-[#1f7a3a]">{{ actionOk }}</p>
        </div>

        <footer class="flex items-center justify-end gap-3 px-[1.4rem] py-[1rem] border-t border-border bg-[color-mix(in_srgb,var(--surface)_92%,var(--bg)_8%)]">
          <button
            type="button"
            class="min-h-[2.4rem] px-4 py-[0.55rem] border border-border rounded-[0.6rem] font-semibold cursor-pointer bg-surface-hover text-text hover:bg-border disabled:opacity-60 disabled:cursor-wait"
            :disabled="saving"
            @click="$emit('close')"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="min-h-[2.4rem] px-4 py-[0.55rem] border border-border rounded-[0.6rem] font-semibold cursor-pointer bg-text text-bg hover:opacity-90 disabled:opacity-60 disabled:cursor-wait"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? t('common.saving') : t('common.save') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import {
  fetchVideosForDomain,
  updateDomainDescription,
  type AiDomainNode,
  type DomainVideo,
} from '../api/ai-analysis';

const props = defineProps<{
  open: boolean;
  domain: AiDomainNode | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [domain: string, description: string | null];
}>();

const { t } = useI18n();
const titleId = `domain-knowledge-${Math.random().toString(36).slice(2, 10)}`;

const descriptionDraft = ref('');
const videos = ref<DomainVideo[]>([]);
const loadingVideos = ref(false);
const saving = ref(false);
const actionError = ref<string | null>(null);
const actionOk = ref<string | null>(null);

const formattedLangs = computed(() => {
  const d = props.domain;
  if (!d) return '—';
  const entries = Object.entries(d.languages);
  if (entries.length === 0) return '—';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.toUpperCase()} (${v})`)
    .join(', ');
});

async function loadForDomain(name: string) {
  loadingVideos.value = true;
  try {
    videos.value = await fetchVideosForDomain(name, 30);
  } catch {
    videos.value = [];
  } finally {
    loadingVideos.value = false;
  }
}

watch(
  () => [props.open, props.domain?.domain] as const,
  async ([isOpen, name]) => {
    if (!isOpen || !name) {
      descriptionDraft.value = '';
      videos.value = [];
      actionError.value = null;
      actionOk.value = null;
      return;
    }
    descriptionDraft.value = props.domain?.description ?? '';
    actionError.value = null;
    actionOk.value = null;
    await loadForDomain(name);
    await nextTick(() => {
      descriptionEl.value?.focus();
    });
  },
  { immediate: true },
);

const descriptionEl = ref<HTMLTextAreaElement | null>(null);

async function save() {
  if (!props.domain) return;
  saving.value = true;
  actionError.value = null;
  actionOk.value = null;
  const next = descriptionDraft.value.trim();
  try {
    const ok = await updateDomainDescription(
      props.domain.domain,
      next === '' ? null : next,
    );
    if (!ok) {
      actionError.value = t('ai.domainKnowledge.saveFailed');
    } else {
      actionOk.value = t('ai.domainKnowledge.saved');
      emit('saved', props.domain.domain, next === '' ? null : next);
      // Refresh the videos list so newly-tagged content shows.
      await loadForDomain(props.domain.domain);
    }
  } catch {
    actionError.value = t('ai.domainKnowledge.saveFailed');
  } finally {
    saving.value = false;
  }
}
</script>
