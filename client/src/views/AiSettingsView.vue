<!--
  AiSettingsView — dedicated AI management submenu.

  Hosts the four AI surfaces in their own route:
    1. Live status (polled)
    2. Providers and pipeline configuration
    3. Domain manager (list / rename / delete / add / edit description)
    4. Folder knowledge (list / override summary, domains, language)

  Four sub-tabs across the top so the page can hold everything without
  scrolling through a long single column. Each tab is one of the existing
  components mounted directly.
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
        <span class="eyebrow">{{ t('ai.settings.eyebrow') }}</span>
        <h1 class="mt-[0.15rem] mb-0 text-[clamp(1.55rem,2.4vw,2rem)] font-medium tracking-[-0.04em]">
          {{ t('ai.settings.title') }}
        </h1>
        <p class="m-0 text-muted">{{ t('ai.settings.subtitle') }}</p>
      </div>
    </header>

    <nav class="flex items-center gap-[0.4rem] border-b border-border">
      <RouterLink
        v-for="t in tabs"
        :key="t.id"
        :to="{ name: 'settings-ai', query: { tab: t.id } }"
        class="px-[0.9rem] py-[0.55rem] text-[0.86rem] font-medium no-underline transition-colors duration-150"
        :class="activeTab === t.id
          ? 'text-text border-b-2 border-accent -mb-[1px]'
          : 'text-muted hover:text-text'"
      >
        {{ t.label }}
      </RouterLink>
    </nav>

    <AiAnalysisStatus v-show="activeTab === 'status'" />
    <AiProviderSettings v-show="activeTab === 'config'" />
    <AiDomainManager v-show="activeTab === 'domains'" />
    <AiSynonymReview v-show="activeTab === 'domains'" />
    <AiFolderKnowledgeManager v-show="activeTab === 'folders'" />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, RouterLink } from 'vue-router';
import AiAnalysisStatus from '../components/AiAnalysisStatus.vue';
import AiProviderSettings from '../components/AiProviderSettings.vue';
import AiDomainManager from '../components/AiDomainManager.vue';
import AiSynonymReview from '../components/AiSynonymReview.vue';
import AiFolderKnowledgeManager from '../components/AiFolderKnowledgeManager.vue';

const { t } = useI18n();
const route = useRoute();

const tabs = [
  { id: 'status', label: '' },
  { id: 'config', label: '' },
  { id: 'domains', label: '' },
  { id: 'folders', label: '' },
];

const activeTab = computed(() => {
  const raw = route.query.tab;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === 'config' || v === 'domains' || v === 'folders') return v;
  return 'status';
});

// Localize labels
tabs[0].label = t('ai.settings.tabStatus');
tabs[1].label = t('ai.config.title');
tabs[2].label = t('ai.settings.tabDomains');
tabs[3].label = t('ai.settings.tabFolders');
</script>
