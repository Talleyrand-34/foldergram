<!--
  AiDomainManager — Settings panel for the AI knowledge graph's domains.

  Lists every domain the analyzer has ever produced (across all videos
  and folders), with counts. Lets the admin:
    - Rename a domain (cascades to edges + every video's ai_domains array)
    - Delete a domain (cascades the same way)
    - Add a custom domain that isn't yet in the graph

  Mounted in Settings below the live-status card. Visible to admins.
-->

<template>
  <section class="card p-5 md:p-6 flex flex-col gap-4">
    <header class="flex items-start justify-between gap-4 max-sm:flex-col max-sm:items-stretch">
      <div>
        <span class="eyebrow">{{ t('ai.domains.heading') }}</span>
        <h2 class="m-0 text-[1.1rem]">{{ t('ai.domains.title') }}</h2>
        <p class="m-0 mt-[0.15rem] text-muted text-[0.86rem]">{{ t('ai.domains.subtitle') }}</p>
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

    <div v-else-if="domains.length === 0 && !loading" class="text-[0.88rem] text-muted italic">
      {{ t('ai.domains.empty') }}
    </div>

    <div v-else class="grid gap-[0.45rem]">
      <div
        v-for="d in domains"
        :key="d.domain"
        class="grid grid-cols-[1fr_auto] items-center gap-[0.55rem] px-[0.75rem] py-[0.5rem] rounded-[0.55rem] border border-border bg-surface-alt gap-y-[0.15rem]"
      >
        <div class="grid gap-[0.05rem] min-w-0">
          <span v-if="editingDomain !== d.domain" class="font-mono text-[0.88rem] text-text truncate">{{ d.domain }}</span>
          <div v-else class="flex items-center gap-[0.4rem]">
            <input
              v-model="editingValue"
              type="text"
              class="flex-1 px-[0.55rem] py-[0.3rem] text-[0.86rem] font-mono bg-surface border border-border rounded text-text focus:outline-none focus:border-text focus:ring-1 focus:ring-text"
              @keydown="onEditKey($event, d.domain)"
              @blur="cancelEdit"
            />
            <button
              type="button"
              class="inline-flex items-center justify-center px-[0.5rem] py-[0.3rem] text-[0.74rem] font-semibold border border-border rounded bg-text text-bg cursor-pointer hover:opacity-90"
              :disabled="editBusy"
              @click="commitEdit(d.domain)"
            >
              {{ t('common.save') }}
            </button>
            <button
              type="button"
              class="inline-flex items-center justify-center px-[0.5rem] py-[0.3rem] text-[0.74rem] font-semibold border border-border rounded bg-transparent text-text cursor-pointer hover:bg-surface-hover"
              @click="cancelEdit"
            >
              {{ t('common.cancel') }}
            </button>
          </div>
          <span class="text-[0.72rem] text-muted tabular-nums">
            {{ d.videoCount }} {{ t('ai.domains.videos') }} ·
            {{ d.folderCount }} {{ t('ai.domains.folders') }} ·
            {{ formatLangs(d.languages) }}
          </span>

        </div>
        <div class="flex items-center gap-[0.3rem]">
          <button
            v-if="editingDomain !== d.domain"
            type="button"
            class="inline-flex items-center justify-center w-7 h-7 rounded-full border-0 bg-transparent text-muted cursor-pointer hover:text-text"
            :aria-label="t('ai.domains.rename')"
            :title="t('ai.domains.rename')"
            @click="startEdit(d)"
          >
            <span class="i-fluent-edit-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
          </button>
          <button
            v-if="editingDomain !== d.domain"
            type="button"
            class="inline-flex items-center justify-center w-7 h-7 rounded-full border-0 bg-transparent text-accent cursor-pointer hover:text-text"
            :aria-label="t('ai.domainKnowledge.open')"
            :title="t('ai.domainKnowledge.open')"
            @click="openKnowledge(d)"
          >
            <span class="i-fluent-book-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="inline-flex items-center justify-center w-7 h-7 rounded-full border-0 bg-transparent text-[#b42318] cursor-pointer hover:bg-[rgba(217,48,37,0.08)]"
            :aria-label="t('ai.domains.delete')"
            :title="t('ai.domains.delete')"
            @click="confirmDelete(d.domain)"
          >
            <span class="i-fluent-delete-16-regular w-[0.95rem] h-[0.95rem]" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-[0.45rem] pt-[0.3rem] border-t border-border">
      <input
        v-model="newDomainName"
        type="text"
        class="flex-1 px-[0.7rem] py-[0.5rem] text-[0.86rem] font-mono bg-surface border border-border rounded text-text placeholder-muted focus:outline-none focus:border-text focus:ring-1 focus:ring-text"
        :placeholder="t('ai.domains.addPlaceholder')"
        @keydown="onAddKey"
      />
      <button
        type="button"
        class="inline-flex items-center gap-[0.3rem] px-[0.7rem] py-[0.5rem] text-[0.82rem] font-semibold border border-border rounded-lg bg-text text-bg hover:opacity-90 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!canAdd || addBusy"
        @click="commitAdd"
      >
        <span class="i-fluent-add-16-regular w-[0.85rem] h-[0.85rem]" aria-hidden="true" />
        {{ t('ai.domains.add') }}
      </button>
    </div>

    <p v-if="actionError" class="m-0 text-[0.78rem] text-[#b42318]">{{ actionError }}</p>
    <p v-if="actionOk" class="m-0 text-[0.78rem] text-[#1f7a3a]">{{ actionOk }}</p>

    <AiDomainKnowledgeEditor
      :open="knowledgeTarget !== null"
      :domain="knowledgeTarget"
      @close="knowledgeTarget = null"
      @saved="onKnowledgeSaved"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  addDomain,
  deleteDomain,
  fetchTopDomains,
  renameDomain,
  type AiDomainNode,
} from '../api/ai-analysis';
import AiDomainKnowledgeEditor from './AiDomainKnowledgeEditor.vue';

const { t } = useI18n();

const domains = ref<AiDomainNode[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const knowledgeTarget = ref<AiDomainNode | null>(null);

function openKnowledge(d: AiDomainNode) {
  knowledgeTarget.value = d;
}

async function onKnowledgeSaved() {
  await refresh();
}

const editingDomain = ref<string | null>(null);
const editingValue = ref('');
const editBusy = ref(false);



const newDomainName = ref('');
const addBusy = ref(false);
const actionError = ref<string | null>(null);
const actionOk = ref<string | null>(null);

const canAdd = computed(() => /^[a-z0-9][a-z0-9/-]*$/.test(newDomainName.value.trim()));

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    domains.value = await fetchTopDomains(500);
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('ai.status.error');
  } finally {
    loading.value = false;
  }
}

function startEdit(d: AiDomainNode) {
  actionError.value = null;
  actionOk.value = null;
  editingDomain.value = d.domain;
  editingValue.value = d.domain;
}

function cancelEdit() {
  editingDomain.value = null;
  editingValue.value = '';
}

function onEditKey(event: KeyboardEvent, original: string) {
  if (event.key === 'Enter') {
    event.preventDefault();
    void commitEdit(original);
  } else if (event.key === 'Escape') {
    cancelEdit();
  }
}

async function commitEdit(original: string) {
  if (editingDomain.value !== original) return;
  const next = editingValue.value.trim();
  if (!next || next === original) {
    cancelEdit();
    return;
  }
  if (!/^[a-z0-9][a-z0-9/-]*$/.test(next)) {
    actionError.value = t('ai.domains.invalidName');
    return;
  }
  editBusy.value = true;
  actionError.value = null;
  actionOk.value = null;
  try {
    const ok = await renameDomain(original, next);
    if (!ok) {
      actionError.value = t('ai.domains.renameFailed');
    } else {
      actionOk.value = t('ai.domains.renamed', { from: original, to: next });
      await refresh();
    }
  } catch {
    actionError.value = t('ai.domains.renameFailed');
  } finally {
    editBusy.value = false;
    editingDomain.value = null;
    editingValue.value = '';
  }
}

function onAddKey(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    void commitAdd();
  }
}

async function commitAdd() {
  const d = newDomainName.value.trim();
  if (!d || !canAdd.value) return;
  addBusy.value = true;
  actionError.value = null;
  actionOk.value = null;
  try {
    const ok = await addDomain(d);
    if (!ok) {
      actionError.value = t('ai.domains.addFailed');
    } else {
      actionOk.value = t('ai.domains.added', { domain: d });
      newDomainName.value = '';
      await refresh();
    }
  } catch {
    actionError.value = t('ai.domains.addFailed');
  } finally {
    addBusy.value = false;
  }
}

async function confirmDelete(name: string) {
  if (!confirm(t('ai.domains.confirmDelete', { domain: name }))) return;
  actionError.value = null;
  actionOk.value = null;
  try {
    const ok = await deleteDomain(name);
    if (!ok) {
      actionError.value = t('ai.domains.deleteFailed');
    } else {
      actionOk.value = t('ai.domains.deleted', { domain: name });
      await refresh();
    }
  } catch {
    actionError.value = t('ai.domains.deleteFailed');
  }
}

function formatLangs(langs: Record<string, number>): string {
  const entries = Object.entries(langs);
  if (entries.length === 0) return '—';
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.toUpperCase()} (${v})`)
    .join(', ');
}

onMounted(refresh);
</script>
