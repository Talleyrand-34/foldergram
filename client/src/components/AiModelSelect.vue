<script setup lang="ts">
/**
 * A model picker.
 *
 * The model names are the easiest thing to get wrong: a typo means the
 * upstream answers "model not found" and the queue refuses to start. So the
 * names are **read from the provider** and offered as a choice, and the field
 * that is configured is always shown — even when the provider does not offer
 * it, which is worth seeing.
 *
 * A provider that does not publish a model list (some gateways do not) falls
 * back to a plain text field, so the name can still be typed.
 */
import { computed, ref, watch } from 'vue';

import { fetchProviderModels, type AiProviderModels } from '../api/ai-analysis';

const props = defineProps<{
  /** The provider whose models are offered. */
  providerId: string;
  /** The configured model. Empty means "the provider's default". */
  modelValue: string;
  /** The text of the empty choice. */
  placeholder?: string;
  /** The provider's default model, shown on the empty choice. */
  defaultModel?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();

/** The lists are kept, so moving back and forth does not read them again. */
const cache = new Map<string, AiProviderModels>();

const models = ref<string[]>([]);
const failed = ref(false);

const value = computed({
  get: () => props.modelValue,
  set: (next: string) => emit('update:modelValue', next),
});

/** The configured model, when the provider does not offer it. */
const notOffered = computed(
  () => props.modelValue !== '' && !models.value.includes(props.modelValue)
);

async function load(providerId: string): Promise<void> {
  if (!providerId) {
    models.value = [];
    failed.value = false;
    return;
  }

  const cached = cache.get(providerId);
  if (cached) {
    models.value = cached.models;
    failed.value = cached.error !== null;
    return;
  }

  try {
    const result = await fetchProviderModels(providerId);
    cache.set(providerId, result);
    models.value = result.models;
    failed.value = result.error !== null;
  } catch {
    failed.value = true;
  }
}

watch(
  () => props.providerId,
  (providerId) => {
    void load(providerId);
  },
  { immediate: true }
);
</script>

<template>
  <select
    v-if="models.length > 0"
    v-model="value"
    class="px-2.5 py-[0.4rem] text-[0.85rem] font-mono bg-surface border border-border rounded text-text"
  >
    <option value="">
      {{ placeholder ?? '—' }}{{ defaultModel ? ` (${defaultModel})` : '' }}
    </option>
    <option v-if="notOffered" :value="modelValue">{{ modelValue }} — not offered</option>
    <option v-for="name in models" :key="name" :value="name">{{ name }}</option>
  </select>

  <input
    v-else
    v-model="value"
    type="text"
    :placeholder="placeholder"
    class="px-2.5 py-[0.4rem] text-[0.85rem] font-mono bg-surface border border-border rounded text-text"
  />
</template>
