<!--
  EditableChipInput — single- or multi-value chip picker with autocomplete.

  Used by the Folder Profile override editor to pick domains and language
  without typing raw values. Three modes:

    mode="multi"  — chips for each value, add/remove freely; a combobox
                    input adds new ones and offers suggestions from a
                    provided list.
    mode="single" — one chip at most; a combobox replaces it.

  Props:
    modelValue:    string[] | string  (v-model)
    suggestions:   string[]           existing values from the data
    placeholder:   string             input placeholder
    validate?:     (v: string) => string | null  (returns error message or null)
    addLabel:      string             label for the 'add custom' CTA
    singleLabel?:  string             label for the active single value
    maxItems?:     number             cap on multi count
    normalize?:    (v: string) => string  (e.g. lowercase, trim)

  UX:
    - Type to filter suggestions; ↓/↑/Enter to pick; Esc to close
    - Press Enter / click 'Add' on a non-matching value to add a new one
      (after passing validate if provided)
    - X on each chip removes it
    - Click outside or blur to close the popover
-->

<template>
  <div class="grid gap-[0.45rem]">
    <div
      v-if="effectiveValues.length > 0"
      class="flex flex-wrap items-center gap-[0.35rem]"
    >
      <span
        v-for="v in effectiveValues"
        :key="v"
        class="inline-flex items-center gap-[0.35rem] px-[0.55rem] py-[0.18rem] text-[0.82rem] font-medium rounded-full border border-border bg-surface text-text"
      >
        <span class="font-mono">{{ v }}</span>
        <button
          type="button"
          class="inline-flex items-center justify-center w-[1rem] h-[1rem] rounded-full border-0 bg-transparent text-muted cursor-pointer hover:text-text"
          :aria-label="t('editableChip.remove', { value: v })"
          @click="remove(v)"
        >
          <span class="i-fluent-dismiss-12-regular w-[0.7rem] h-[0.7rem]" aria-hidden="true" />
        </button>
      </span>
    </div>

    <div class="relative">
      <div class="flex items-center gap-[0.45rem]">
        <input
          ref="inputEl"
          v-model="draft"
          type="text"
          class="flex-1 px-[0.7rem] py-[0.5rem] text-[0.88rem] bg-surface border border-border rounded-lg text-text placeholder-muted focus:outline-none focus:border-text focus:ring-1 focus:ring-text font-mono"
          :placeholder="placeholder"
          @keydown="onKeyDown"
          @focus="open = true"
          @input="open = true"
        />
        <button
          v-if="draft.trim() && !exactMatch"
          type="button"
          class="inline-flex items-center gap-[0.3rem] px-[0.7rem] py-[0.5rem] text-[0.82rem] font-semibold border border-border rounded-lg bg-text text-bg hover:opacity-90 cursor-pointer"
          @click.prevent="commit(draft)"
        >
          <span class="i-fluent-add-16-regular w-[0.85rem] h-[0.85rem]" aria-hidden="true" />
          {{ addLabel }}<span v-if="draft.trim()" class="font-mono opacity-85">"{{ draft.trim() }}"</span>
        </button>
      </div>

      <div
        v-if="open && filteredSuggestions.length > 0"
        class="absolute z-30 left-0 right-0 mt-[0.3rem] max-h-[14rem] overflow-y-auto rounded-[0.6rem] border border-border bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
      >
        <button
          v-for="(s, i) in filteredSuggestions"
          :key="s"
          type="button"
          class="w-full flex items-center gap-[0.55rem] px-[0.7rem] py-[0.5rem] text-[0.86rem] text-text text-left border-0 bg-transparent cursor-pointer transition-colors duration-120 hover:bg-surface-hover"
          :class="i === highlightedIndex ? 'bg-surface-hover' : ''"
          @mousedown.prevent
          @click="commit(s)"
          @mouseenter="highlightedIndex = i"
        >
          <span class="i-fluent-arrow-right-12-regular w-[0.85rem] h-[0.85rem] opacity-50 shrink-0" aria-hidden="true" />
          <span class="font-mono">{{ s }}</span>
        </button>
      </div>
      <p
        v-if="open && draft.trim() && filteredSuggestions.length === 0 && !exactMatch"
        class="absolute z-30 left-0 right-0 mt-[0.3rem] rounded-[0.6rem] border border-border bg-surface px-[0.7rem] py-[0.5rem] text-[0.78rem] text-muted shadow-[0_8px_24px_rgba(0,0,0,0.18)]"
      >
        {{ t('editableChip.createHint', { value: draft.trim() }) }}
      </p>
    </div>
    <p
      v-if="errorMessage"
      class="m-0 text-[0.78rem] text-[#b42318]"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(
  defineProps<{
    modelValue: string[] | string;
    suggestions?: string[];
    placeholder?: string;
    addLabel?: string;
    maxItems?: number;
    validate?: (value: string) => string | null;
    normalize?: (value: string) => string;
    mode?: 'multi' | 'single';
  }>(),
  {
    suggestions: () => [],
    placeholder: '',
    addLabel: 'Add',
    maxItems: 30,
    validate: undefined,
    normalize: undefined,
    mode: 'multi',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string[] | string];
}>();

const { t } = useI18n();
const inputEl = ref<HTMLInputElement | null>(null);

const draft = ref('');
const open = ref(false);
const highlightedIndex = ref(-1);
const errorMessage = ref<string | null>(null);

const isMulti = computed(() => Array.isArray(props.modelValue));

const effectiveValues = computed<string[]>(() => {
  return Array.isArray(props.modelValue)
    ? props.modelValue
    : props.modelValue
      ? [props.modelValue]
      : [];
});

const exactMatch = computed(() => {
  const d = normalize(draft.value).toLowerCase();
  return effectiveValues.value.some((v) => v.toLowerCase() === d) ||
    props.suggestions.some((s) => s.toLowerCase() === d);
});

const filteredSuggestions = computed<string[]>(() => {
  const used = new Set(effectiveValues.value.map((v) => v.toLowerCase()));
  const q = draft.value.trim().toLowerCase();
  return props.suggestions
    .filter((s) => !used.has(s.toLowerCase()))
    .filter((s) => (q === '' || s.toLowerCase().includes(q)))
    .slice(0, 12);
});

function normalize(v: string): string {
  const trimmed = v.trim();
  if (!props.normalize) return trimmed;
  return props.normalize(trimmed);
}

function commit(raw: string) {
  errorMessage.value = null;
  const v = normalize(raw);
  if (!v) return;
  if (effectiveValues.value.some((x) => x.toLowerCase() === v.toLowerCase())) {
    draft.value = '';
    open.value = false;
    return;
  }
  if (props.validate) {
    const err = props.validate(v);
    if (err) {
      errorMessage.value = err;
      return;
    }
  }
  if (isMulti.value) {
    if (effectiveValues.value.length >= props.maxItems) {
      errorMessage.value = `Max ${props.maxItems} items`;
      return;
    }
    emit('update:modelValue', [...effectiveValues.value, v]);
  } else {
    emit('update:modelValue', v);
  }
  draft.value = '';
  highlightedIndex.value = -1;
  open.value = false;
  void nextTick(() => inputEl.value?.focus());
}

function remove(v: string) {
  if (isMulti.value) {
    emit(
      'update:modelValue',
      effectiveValues.value.filter((x) => x !== v),
    );
  } else if ((props.modelValue as string) === v) {
    emit('update:modelValue', isMulti.value ? [] : '');
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (highlightedIndex.value >= 0 && highlightedIndex.value < filteredSuggestions.value.length) {
      commit(filteredSuggestions.value[highlightedIndex.value]);
    } else if (draft.value.trim()) {
      commit(draft.value);
    }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlightedIndex.value = Math.min(filteredSuggestions.value.length - 1, highlightedIndex.value + 1);
    open.value = true;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlightedIndex.value = Math.max(-1, highlightedIndex.value - 1);
  } else if (event.key === 'Escape') {
    open.value = false;
    highlightedIndex.value = -1;
  } else if (event.key === 'Backspace' && !draft.value && effectiveValues.value.length > 0) {
    // Pop the last chip with Backspace when input is empty.
    if (isMulti.value) {
      emit(
        'update:modelValue',
        effectiveValues.value.slice(0, -1),
      );
    } else {
      emit('update:modelValue', isMulti.value ? [] : '');
    }
  }
}

// Reset highlight when filter input changes
watch(draft, () => { highlightedIndex.value = -1; });

// Close the popover on outside click
function onDocClick(event: MouseEvent) {
  if (!inputEl.value) return;
  const target = event.target as Node | null;
  if (target && inputEl.value.parentElement?.contains(target)) return;
  open.value = false;
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick);
});

watch(open, (o) => {
  if (o) document.addEventListener('mousedown', onDocClick);
  else document.removeEventListener('mousedown', onDocClick);
});
</script>
