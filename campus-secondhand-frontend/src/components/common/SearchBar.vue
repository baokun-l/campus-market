<template>
  <div class="search-bar">
    <el-input
      v-model="kw"
      :placeholder="placeholder"
      clearable
      :disabled="disabled"
      @keyup.enter="emit('search', kw)"
      @clear="emit('update:modelValue', '')"
    >
      <template #prefix>
        <el-icon><Search /></el-icon>
      </template>
      <template #append>
        <el-button
          type="primary"
          :disabled="disabled"
          @click="emit('search', kw)"
        >
          搜索
        </el-button>
      </template>
    </el-input>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

interface Props {
  modelValue?: string
  placeholder?: string
  disabled?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  modelValue: '',
  placeholder: '搜索二手商品 / 用户 / 标签',
  disabled: false
})
const emit = defineEmits<{
  'update:modelValue': [v: string]
  search: [v: string]
}>()

const kw = ref(props.modelValue)
watch(() => props.modelValue, v => (kw.value = v))
watch(kw, v => emit('update:modelValue', v))
</script>

<style scoped>
.search-bar { width: 100%; }
</style>
