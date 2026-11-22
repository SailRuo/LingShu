import { ref } from 'vue';
import type { MemoryAgentFilter } from './useMemoryApiContext';

/**
 * 记忆页各 tab 共享的智能体筛选。
 *
 * 放在模块作用域：切 tab 时只替换内容区，顶栏的 MemoryPageShell 和筛选值
 * 都不重建；离开记忆页再回来也保持上次选择。
 */
const agentFilter = ref<MemoryAgentFilter>(0);

export function useMemoryPageFilter() {
  return agentFilter;
}
