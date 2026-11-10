<script setup lang="ts">
/**
 * A small segmented control.
 *
 * Two choices, side by side — the kind of thing that is a radio group in
 * spirit and a pair of buttons in practice. The chosen one is filled, the
 * other is not, so the current choice is readable at a glance.
 */
defineProps<{
  /** The chosen value. */
  modelValue: string;
  /** The choices. */
  options: Array<{ value: string; label: string }>;
  /** The label of the whole control, for assistive technology. */
  ariaLabel?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();
</script>

<template>
  <div
    class="inline-flex items-center gap-[0.15rem] rounded-[0.55rem] border border-border bg-surface p-[0.15rem]"
    role="group"
    :aria-label="ariaLabel"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="rounded-[0.4rem] px-2.5 py-[0.28rem] text-[0.78rem] font-semibold leading-none transition-colors duration-150 cursor-pointer"
      :class="option.value === modelValue
        ? 'bg-surface-hover text-text'
        : 'text-muted hover:text-text'"
      :aria-pressed="option.value === modelValue"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
