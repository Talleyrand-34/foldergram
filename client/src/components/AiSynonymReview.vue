<!--
  AiSynonymReview — admin panel for approving/rejecting laya-detected
  domain synonyms. laya may decide that an M3-proposed domain string is a
  synonym for an existing canonical domain; we use the canonical one in
  the video's tags, but record the alias here for admin approval. Approved
  aliases get added to a synonyms table; rejected ones stay out.
-->

<template>
  <section class="card p-5 md:p-6 flex flex-col gap-4">
    <header class="flex items-start justify-between gap-4">
      <div>
        <span class="eyebrow">{{ t('ai.synonyms.heading') }}</span>
        <h2 class="m-0 text-[1.1rem]">{{ t('ai.synonyms.title') }}</h2>
        <p class="m-0 mt-[0.15rem] text-muted text-[0.86rem]">
          {{ t('ai.synonyms.subtitle') }}
        </p>
      </div>
      <span
        v-if="!loading && pending.length > 0"
        class="inline-flex items-center justify-center px-2 py-[0.2rem] text-[0.74rem] font-bold tabular-nums rounded-full border border-accent/30 bg-accent/10 text-accent"
      >
        {{ pending.length }}
      </span>
    </header>

    <div v-if="loading" class="text-[0.86rem] text-muted italic">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="error" class="px-3 py-2 rounded-[0.55rem] border border-[rgba(217,48,37,0.24)] text-[0.86rem] text-[#b42318] bg-[rgba(217,48,37,0.08)]">
      {{ error }}
    </div>
    <div v-else-if="pending.length === 0" class="text-[0.86rem] text-muted italic">
      {{ t('ai.synonyms.empty') }}
    </div>

    <div v-else class="grid gap-[0.55rem] max-h-[28rem] overflow-y-auto">
      <div
        v-for="s in pending"
        :key="s.id"
        class="grid gap-[0.45rem] px-[0.85rem] py-[0.7rem] rounded-[0.55rem] border border-border bg-surface-alt"
      >
        <div class="flex items-center gap-[0.5rem]">
          <span class="font-mono text-[0.84rem] text-text truncate">{{ s.proposedAlias }}</span>
          <span class="i-fluent-arrow-right-16-regular w-[1rem] h-[1rem] text-muted shrink-0" aria-hidden="true" />
          <span class="font-mono text-[0.84rem] text-accent font-semibold truncate">{{ s.canonicalDomain }}</span>
        </div>
        <div class="flex items-center gap-[0.5rem] text-[0.74rem] text-muted tabular-nums">
          <span v-if="s.confidence !== null">{{ t('ai.synonyms.confidence', { n: s.confidence }) }}</span>
          <span v-if="s.sourceVideoId">·</span>
          <span v-if="s.sourceVideoId">{{ t('ai.synonyms.video', { id: s.sourceVideoId }) }}</span>
          <span>·</span>
          <span>{{ formatDate(s.detectedAt) }}</span>
        </div>
        <p v-if="s.reason" class="m-0 text-[0.78rem] text-text/85 italic">
          {{ s.reason }}
        </p>
        <div class="flex items-center gap-[0.4rem] mt-[0.15rem]">
          <button
            type="button"
            class="inline-flex items-center gap-[0.3rem] px-[0.7rem] py-[0.3rem] text-[0.74rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-text text-bg cursor-pointer hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="busy === s.id"
            @click="resolve(s.id, 'approved')"
          >
            <span class="i-fluent-checkmark-16-filled w-[0.85rem] h-[0.85rem]" aria-hidden="true" />
            {{ t('ai.synonyms.approve') }}
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-[0.3rem] px-[0.7rem] py-[0.3rem] text-[0.74rem] font-semibold leading-none rounded-[0.55rem] border border-border bg-transparent text-text cursor-pointer hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="busy === s.id"
            @click="resolve(s.id, 'rejected')"
          >
            <span class="i-fluent-dismiss-16-regular w-[0.85rem] h-[0.85rem]" aria-hidden="true" />
            {{ t('ai.synonyms.reject') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { fetchPendingSynonyms, resolvePendingSynonym, type PendingSynonym } from '../api/ai-analysis';

const { t } = useI18n();
const pending = ref<PendingSynonym[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const busy = ref<number | null>(null);

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    pending.value = await fetchPendingSynonyms();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('common.unknownError');
  } finally {
    loading.value = false;
  }
}

async function resolve(id: number, resolution: 'approved' | 'rejected') {
  busy.value = id;
  try {
    const ok = await resolvePendingSynonym(id, resolution);
    if (ok) await refresh();
  } finally {
    busy.value = null;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

onMounted(refresh);
defineExpose({ refresh });
</script>
