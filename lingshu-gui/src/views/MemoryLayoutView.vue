<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import MemoryPageShell from '../components/memory/MemoryPageShell.vue';
import { MEMORY_NAV_ITEMS } from '../components/memory/memoryNav';
import { useMemoryPageFilter } from '../composables/useMemoryPageFilter';

const route = useRoute();
const agentFilter = useMemoryPageFilter();

const current = computed(() => MEMORY_NAV_ITEMS.find((item) => item.path === route.path));
const showHeaderActions = computed(() => route.meta.memoryHeaderActions === true);
</script>

<template>
  <MemoryPageShell
    v-model:agent-filter="agentFilter"
    :title="current?.title || '记忆'"
    :subtitle="current?.subtitle"
    :show-header-actions="showHeaderActions"
  >
    <!--
      7 个 tab 是同一布局下的子路由：切换时只替换这里的内容，
      顶栏/智能体选择器/导航不会卸载重建。keep-alive 保留各页状态。
    -->
    <router-view v-slot="{ Component }">
      <keep-alive>
        <component :is="Component" />
      </keep-alive>
    </router-view>
  </MemoryPageShell>
</template>
